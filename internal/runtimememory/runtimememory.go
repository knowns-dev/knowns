package runtimememory

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/howznguyen/knowns/internal/memoryreview"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
)

const (
	ModeOff    = "off"
	ModeAuto   = "auto"
	ModeManual = "manual"
	ModeDebug  = "debug"

	CaptureDisabled       = "disabled"
	CapturePropose        = "propose"
	CaptureHighConfidence = "high-confidence"

	StatusNone      = "none"
	StatusCandidate = "candidate"
	StatusInjected  = "injected"

	SkipReasonModeOff            = "mode_off"
	SkipReasonDebugMode          = "debug_mode"
	SkipReasonLowSignalPrompt    = "low_signal_prompt"
	SkipReasonNoCandidates       = "no_candidates"
	SkipReasonBelowThreshold     = "below_threshold"
	SkipReasonMissingStore       = "missing_store"
	SkipReasonNoCaptureCandidate = "no_capture_candidate"
	SkipReasonDuplicateCapture   = "duplicate_capture"
	SkipReasonReviewRequired     = "review_required"
	SkipReasonCaptureDisabled    = "capture_disabled"
	SkipReasonCaptureConfidence  = "capture_below_confidence"

	CaptureStatusSkipped = "skipped"
	CaptureStatusCreated = "created"

	HookNative            = "native"
	HookProxyPreExecution = "proxy-pre-execution"
	HookWrapper           = "wrapper"
	HookAdapter           = "adapter"

	HeaderMode   = "X-Knowns-Runtime-Memory-Mode"
	HeaderInject = "X-Knowns-Runtime-Memory-Inject"
	HeaderStatus = "X-Knowns-Runtime-Memory-Status"
	HeaderItems  = "X-Knowns-Runtime-Memory-Items"
	HeaderPack   = "X-Knowns-Runtime-Memory-Pack"
)

const canonicalityWarning = "Knowns memory is supplemental context only and does not override source-of-truth docs, tasks, or source files."

const silentSupplementalWarning = "Silent supplemental context. Do not quote unless asked."

const (
	defaultMaxItems  = 5
	defaultMaxBytes  = 2500
	maxPreviewBody   = 320
	baselineMaxItems = 4
)

var tokenRE = regexp.MustCompile(`[a-z0-9]+`)

// Relevance floors. Both are absolute, and both sit on a signal that does not
// grow with the length of the prompt, which is the whole point: the old
// threshold compared a fixed number against `0.35 × shared words`, so a longer
// prompt cleared it more easily whether or not it was more relevant.
const (
	// semanticRelevanceFloor is the raw cosine a hybrid hit must reach.
	//
	// Calibrated 2026-09-12 on qwen3-embedding:0.6b against the live store:
	// prompts that were about a stored memory had a best hit of 0.62 to 0.67;
	// prompts about nothing stored ("ok cảm ơn", "database connection pool")
	// peaked at 0.50 and 0.37. The floor sits in that gap. It is specific to
	// the embedding model: a different model has a different cosine
	// distribution and would need recalibrating.
	semanticRelevanceFloor = 0.55
	// keywordRelevanceFloor applies only when the semantic layer is
	// unavailable. It is a FRACTION of the prompt's content words found in
	// the memory, so adding unrelated words can only lower it.
	keywordRelevanceFloor = 0.5
	// Tie-breakers for hybrid ranking. Their sum is capped well below the
	// cosine gap between a relevant and an unrelated memory, so they order
	// near-equal matches and can never lift a weak one past a strong one.
	hybridKeywordTiebreak = 0.03
	hybridProjectTiebreak = 0.01
)

// matchStopwords are dropped before counting shared words. Kept to function
// words only (articles, pronouns, prepositions, conjunctions, auxiliaries,
// question words) in folded form, since tokens are folded before lookup.
// Tokens shorter than three letters are already dropped, which covers most
// Vietnamese function words (va, la, co, da).
var matchStopwords = func() map[string]struct{} {
	words := strings.Fields(`
		the and for with that this from into what when where which who how why
		are was were have has had not but you your can should would could will
		about there their then than also only just does did been being its our
		all any some more most very like them they these those here please
		khi cho thi cua voi nhu nay kia nhung cac mot nhieu rat cung dang duoc
		khong nen phai sao trong tren duoi sau truoc giua bang tai neu hay hoac
		chi van lai roi vay nao ban toi minh nhe thoi day`)
	set := make(map[string]struct{}, len(words))
	for _, w := range words {
		set[w] = struct{}{}
	}
	return set
}()

var lowSignalPromptTokens = map[string]struct{}{
	"again":    {},
	"continue": {},
	"go":       {},
	"hello":    {},
	"hey":      {},
	"hi":       {},
	"next":     {},
	"no":       {},
	"ok":       {},
	"okay":     {},
	"retry":    {},
	"sure":     {},
	"thank":    {},
	"thanks":   {},
	"yes":      {},
}

type Settings struct {
	Mode     string
	Capture  string
	MaxItems int
	MaxBytes int
}

type Input struct {
	Runtime     string
	ProjectRoot string
	WorkingDir  string
	ActionType  string
	UserPrompt  string
	Mode        string
	Capture     string
	MaxItems    int
	MaxBytes    int
}

type Item struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Category  string    `json:"category"`
	Layer     string    `json:"layer"`
	Status    string    `json:"status,omitempty"`
	UpdatedAt time.Time `json:"updatedAt"`
	Content   string    `json:"content"`
	// Claim is what actually reaches the agent. Content stays whole so the
	// debug pack can show what was held back next to what was sent.
	Claim     string `json:"claim,omitempty"`
	HasDetail bool   `json:"hasDetail,omitempty"`
	FullBytes int    `json:"fullBytes,omitempty"`
	// Semantic is the raw cosine for a hybrid hit; KeywordMatch is the share of
	// the prompt's content words found in the entry. Each is what its own
	// retrieval path is judged on, and both are carried so a rejected entry can
	// be told apart from a missing one.
	Semantic     float64  `json:"semanticScore,omitempty"`
	KeywordMatch float64  `json:"keywordMatch,omitempty"`
	Score        float64  `json:"score"`
	Retrieval    string   `json:"retrieval,omitempty"`
	MatchedBy    []string `json:"matchedBy,omitempty"`
	Reasons      []string `json:"reasons,omitempty"`
	Tags         []string `json:"tags,omitempty"`
}

type hybridCandidate struct {
	entry *models.MemoryEntry
	// score is the engine's fused RANK, top result always 1.0. Kept for
	// callers that only need ordering; never used as relevance.
	score float64
	// semantic is the raw cosine of the best-matching chunk. This is the
	// relevance signal: absolute, and stable across prompt length.
	semantic  float64
	matchedBy []string
}

type candidate struct {
	item Item
}

var lookupHybridCandidates = defaultHybridCandidates

type Pack struct {
	Runtime string `json:"runtime"`
	Mode    string `json:"mode"`
	Status  string `json:"status"`

	Warning        string          `json:"warning"`
	Items          []Item          `json:"items"`
	Candidates     []Item          `json:"candidates,omitempty"`
	Serialized     string          `json:"serialized,omitempty"`
	Bytes          int             `json:"bytes"`
	SkipReason     string          `json:"skipReason,omitempty"`
	CandidateCount int             `json:"candidateCount"`
	SelectedCount  int             `json:"selectedCount"`
	RetrievalMode  string          `json:"retrievalMode,omitempty"`
	Capture        *CaptureOutcome `json:"capture,omitempty"`
}

type CaptureOutcome struct {
	Status       string               `json:"status"`
	Reason       string               `json:"reason,omitempty"`
	Created      bool                 `json:"created"`
	MemoryID     string               `json:"memoryId,omitempty"`
	MemoryStatus string               `json:"memoryStatus,omitempty"`
	Score        float64              `json:"score,omitempty"`
	Threshold    float64              `json:"threshold,omitempty"`
	Trusted      bool                 `json:"trusted"`
	TrustReason  string               `json:"trustReason,omitempty"`
	Matches      []memoryreview.Match `json:"matches,omitempty"`

	// ExpiredProposals counts entries this call retired from the review queue.
	ExpiredProposals int `json:"expiredProposals,omitempty"`
}

type Adapter struct {
	Runtime        string   `json:"runtime"`
	DisplayName    string   `json:"displayName"`
	HookKind       string   `json:"hookKind"`
	NativeHooks    bool     `json:"nativeHooks"`
	SupportedModes []string `json:"supportedModes"`
}

func DefaultAdapters() []Adapter {
	return []Adapter{
		{
			Runtime:        "kiro",
			DisplayName:    "Kiro",
			HookKind:       HookNative,
			NativeHooks:    true,
			SupportedModes: []string{ModeOff, ModeAuto, ModeManual, ModeDebug},
		},
		{
			Runtime:        "claude-code",
			DisplayName:    "Claude Code",
			HookKind:       HookWrapper,
			SupportedModes: []string{ModeOff, ModeAuto, ModeManual, ModeDebug},
		},
		{
			Runtime:        "codex",
			DisplayName:    "Codex",
			HookKind:       HookNative,
			NativeHooks:    true,
			SupportedModes: []string{ModeOff, ModeAuto, ModeManual, ModeDebug},
		},
		{
			Runtime:        "opencode",
			DisplayName:    "OpenCode",
			HookKind:       HookProxyPreExecution,
			SupportedModes: []string{ModeOff, ModeAuto, ModeManual, ModeDebug},
		},
		{
			Runtime:        "antigravity",
			DisplayName:    "Antigravity",
			HookKind:       HookAdapter,
			SupportedModes: []string{ModeOff, ModeAuto, ModeManual, ModeDebug},
		},
	}
}

func LookupAdapter(runtime string) (Adapter, bool) {
	runtime = strings.TrimSpace(strings.ToLower(runtime))
	for _, adapter := range DefaultAdapters() {
		if adapter.Runtime == runtime {
			return adapter, true
		}
	}
	return Adapter{}, false
}

func NormalizeSettings(cfg *models.RuntimeMemorySettings) Settings {
	settings := Settings{
		Mode:     ModeAuto,
		Capture:  CaptureHighConfidence,
		MaxItems: defaultMaxItems,
		MaxBytes: defaultMaxBytes,
	}
	if cfg == nil {
		return settings
	}
	if mode := NormalizeMode(cfg.Mode); mode != "" {
		settings.Mode = mode
	}
	settings.Capture = NormalizeCaptureMode(cfg.Capture)
	if cfg.MaxItems > 0 {
		settings.MaxItems = cfg.MaxItems
	}
	if cfg.MaxBytes > 0 {
		settings.MaxBytes = cfg.MaxBytes
	}
	return settings
}

func NormalizeMode(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case ModeOff:
		return ModeOff
	case ModeManual:
		return ModeManual
	case ModeDebug:
		return ModeDebug
	case "", ModeAuto:
		return ModeAuto
	default:
		return ModeAuto
	}
}

func NormalizeCaptureMode(capture string) string {
	switch strings.ToLower(strings.TrimSpace(capture)) {
	case CaptureDisabled, "off", "none", "false":
		return CaptureDisabled
	case CapturePropose, "proposed":
		return CapturePropose
	case "", "auto", CaptureHighConfidence, "high_confidence", "highconfidence":
		return CaptureHighConfidence
	default:
		return CaptureHighConfidence
	}
}

func Build(store *storage.Store, input Input) (Pack, error) {
	mode := NormalizeMode(input.Mode)
	pack := Pack{
		Runtime: input.Runtime,
		Mode:    mode,
		Status:  StatusNone,
		Warning: canonicalityWarning,
	}
	if mode == ModeOff {
		pack.SkipReason = SkipReasonModeOff
		return pack, nil
	}
	if store == nil {
		pack.SkipReason = SkipReasonMissingStore
		return pack, nil
	}
	if _, ok := LookupAdapter(input.Runtime); !ok {
		return pack, fmt.Errorf("unsupported runtime adapter: %s", input.Runtime)
	}
	isSessionBaseline := shouldUseSessionBaseline(input.ActionType, input.UserPrompt)
	if reason := promptSkipReason(input.UserPrompt); reason != "" && !isSessionBaseline {
		pack.SkipReason = reason
		return pack, nil
	}
	maxItems := input.MaxItems
	if maxItems <= 0 {
		maxItems = defaultMaxItems
	}
	if isSessionBaseline && maxItems > baselineMaxItems {
		// A real ceiling, not a default. The old condition was `input.MaxItems
		// <= 0`, which never held: settings.MaxItems is always filled in from
		// config before it reaches here, so baselineMaxItems had no effect at
		// all. The session opener is a short list of commitments; more entries
		// only push the ones that matter down the page.
		maxItems = baselineMaxItems
	}
	maxBytes := input.MaxBytes
	if maxBytes <= 0 {
		maxBytes = defaultMaxBytes
	}

	candidates, err := buildCandidates(store, input, maxItems, isSessionBaseline)
	if err != nil {
		return pack, err
	}

	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].item.Score != candidates[j].item.Score {
			return candidates[i].item.Score > candidates[j].item.Score
		}
		if !candidates[i].item.UpdatedAt.Equal(candidates[j].item.UpdatedAt) {
			return candidates[i].item.UpdatedAt.After(candidates[j].item.UpdatedAt)
		}
		return candidates[i].item.ID < candidates[j].item.ID
	})

	// The floor applies BEFORE the item cap, so an entry that did not match
	// well enough can never take a slot from one that did. The session
	// baseline is exempt: at session start there is no question to be relevant
	// to, and it is ranked on its own terms.
	eligible := candidates
	if !isSessionBaseline {
		eligible = make([]candidate, 0, len(candidates))
		for _, c := range candidates {
			if clearsInjectionFloor(c.item) {
				eligible = append(eligible, c)
			}
		}
	}
	selected := capItems(eligible, maxItems)
	pack.CandidateCount = len(candidates)
	pack.RetrievalMode = retrievalModeForItems(selected)
	if pack.RetrievalMode == "" {
		pack.RetrievalMode = retrievalModeForItems(capItems(candidates, maxItems))
	}

	if mode == ModeDebug {
		// Debug shows what was FOUND, including what the floor rejected, so a
		// memory that matched weakly can be told apart from one never found.
		pack.Candidates = capItems(candidates, maxItems)
		if len(selected) == 0 {
			pack.SkipReason = SkipReasonNoCandidates
			if !isSessionBaseline && len(candidates) > 0 {
				pack.SkipReason = SkipReasonBelowThreshold
			}
			return pack, nil
		}
		pack.Status = StatusCandidate
		return pack, nil
	}

	prefix := trimToByteLimit(serializePrefix(input.Runtime), maxBytes)
	serialized := prefix

	if !isSessionBaseline && len(selected) == 0 && len(candidates) > 0 {
		// Found, but nothing matched well enough. Kept distinct from finding
		// nothing, because the remedy for each is different.
		pack.Candidates = capItems(candidates, maxItems)
		pack.SkipReason = SkipReasonBelowThreshold
		pack.Bytes = len(prefix)
		return pack, nil
	}
	if len(selected) == 0 {
		if isSessionBaseline {
			block := serializeKNOWNSSummary(store, maxBytes-len(serialized))
			if block != "" {
				serialized += block
			}
		}
		if strings.TrimSpace(serialized) == strings.TrimSpace(prefix) {
			pack.SkipReason = SkipReasonNoCandidates
			pack.Bytes = len(prefix)
			return pack, nil
		}
		pack.Serialized = trimToByteLimit(serialized, maxBytes)
		pack.Bytes = len(pack.Serialized)
		pack.Status = StatusCandidate
		pack.SelectedCount = len(pack.Items)
		return pack, nil
	}

	serializedItems := make([]Item, 0, len(selected))
	itemBlock := serializeItems(selected, maxBytes-len(serialized), &serializedItems)
	if itemBlock != "" {
		serialized += itemBlock
	}
	if isSessionBaseline || len(serializedItems) > 0 {
		block := serializeKNOWNSSummary(store, maxBytes-len(serialized))
		if block != "" {
			serialized += block
		}
	}
	if len(serializedItems) == 0 && !isSessionBaseline {
		pack.Bytes = len(prefix)
		return pack, nil
	}

	pack.Items = serializedItems
	pack.Serialized = serialized
	pack.Bytes = len(serialized)
	pack.Status = StatusCandidate
	pack.SelectedCount = len(serializedItems)
	return pack, nil
}

func Capture(store *storage.Store, input Input) (*models.MemoryEntry, bool, error) {
	entry, outcome, err := CaptureWithOutcome(store, input)
	return entry, outcome.Created, err
}

func CaptureWithOutcome(store *storage.Store, input Input) (*models.MemoryEntry, CaptureOutcome, error) {
	outcome := CaptureOutcome{Status: CaptureStatusSkipped}
	if store == nil {
		outcome.Reason = SkipReasonMissingStore
		return nil, outcome, nil
	}
	captureMode := NormalizeCaptureMode(input.Capture)
	switch NormalizeMode(input.Mode) {
	case ModeOff:
		outcome.Reason = SkipReasonModeOff
		return nil, outcome, nil
	case ModeDebug:
		outcome.Reason = SkipReasonDebugMode
		return nil, outcome, nil
	}
	if captureMode == CaptureDisabled {
		outcome.Reason = SkipReasonCaptureDisabled
		return nil, outcome, nil
	}
	if reason := promptSkipReason(input.UserPrompt); reason != "" {
		outcome.Reason = reason
		return nil, outcome, nil
	}
	// NOTHING IS CAPTURED FROM PROMPT TEXT ANY MORE, and this function keeps
	// its signature so the `--capture` flag, settings.Capture and the hook's
	// JSON envelope stay exactly as they shipped.
	//
	// The two inferences that used to run here read a phrase out of the user's
	// prompt and wrote it down as durable knowledge. A prompt is a REQUEST, not
	// a conclusion: at prompt time nothing has been established yet. The
	// working-context inference made that concrete by matching on "currently",
	// "for now", "temporary" and "this session", the exact vocabulary of a
	// fact about to expire, and then stored it forever. The preference
	// inference was worse: it overwrote Content with a hard-coded sentence, so
	// it attributed to the user a statement the user had never made.
	//
	// The two together produced 86 of the 107 entries in the reference store
	// and not one of them ever reached `active`. Memory now comes only from a
	// deliberate `add`, where an agent writes from an outcome it just reached.
	//
	// The checks above still run, so mode=off, mode=debug, capture=disabled and
	// the low-signal prompt filter keep reporting the reasons callers match on.
	// SkipReasonCaptureConfidence, SkipReasonDuplicateCapture and
	// SkipReasonReviewRequired are now unreachable; they stay exported because
	// they are part of the hook's published JSON vocabulary, and retiring that
	// surface is its own change.
	outcome.ExpiredProposals = expireAbandonedProposals(store, time.Now().UTC())
	outcome.Reason = SkipReasonNoCaptureCandidate
	return nil, outcome, nil
}

// expireAbandonedProposals retires `proposed` entries that outlived the queue,
// and returns how many it retired.
//
// THIS IS WHERE THE QUEUE BECOMES SELF-LIMITING. A review queue only works if
// somebody empties it, and this project's did not: 48 entries sat unresolved
// because nothing expired them and nothing announced them. Left that way a
// proposal is the worst of both states, never retrieved so it helps nobody,
// never removed so it keeps burying the entries a person would actually want to
// read.
//
// It runs here because this hook already fires on every prompt and this
// function is already the write path, so no new trigger and no new schedule has
// to exist for the rule to hold. Until now it manufactured the junk; the same
// call now clears it.
//
// The write cannot affect the prompt in flight: an expired proposal was already
// invisible to retrieval, so changing its status changes nothing the current
// injection would have shown. A read error or a write error is swallowed on
// purpose, because failing to tidy a backlog must never fail a user's prompt.
func expireAbandonedProposals(store *storage.Store, now time.Time) int {
	entries, err := store.Memory.List("")
	if err != nil {
		return 0
	}
	expired := 0
	for _, entry := range entries {
		if !models.ProposalIsExpired(entry, models.MemoryProposalTTLDays, now) {
			continue
		}
		entry.Status = models.MemoryStatusRejected
		entry.RejectedReason = "expired_unreviewed"
		entry.UpdatedAt = now
		if err := store.Memory.Update(entry); err == nil {
			expired++
		}
	}
	return expired
}

func buildCandidates(store *storage.Store, input Input, maxItems int, baseline bool) ([]candidate, error) {
	if baseline {
		entries, err := store.Memory.List("")
		if err != nil {
			return nil, err
		}
		return buildBaselineItems(entries, input), nil
	}
	limit := max(maxItems*4, 20)
	if hybrid, ok := lookupHybridCandidates(store, input, limit); ok {
		// When the semantic layer ran, its answer stands, INCLUDING "nothing
		// here is relevant". Falling back to keyword matching whenever no
		// hybrid candidate cleared was how "ok cảm ơn" could still inject
		// whatever shared a word with it. Keyword matching is for when the
		// semantic layer is unavailable, not for overruling it.
		return buildHybridItems(hybrid, input), nil
	}

	entries, err := store.Memory.List("")
	if err != nil {
		return nil, err
	}
	return buildHeuristicItems(entries, input), nil
}

func memoryVisibleForRuntime(entry *models.MemoryEntry, input Input) bool {
	if entry == nil {
		return false
	}
	if NormalizeMode(input.Mode) == ModeDebug {
		return true
	}
	return entry.CurrentForDefaultRetrieval()
}

func buildBaselineItems(entries []*models.MemoryEntry, input Input) []candidate {
	candidates := make([]candidate, 0, len(entries))
	for _, entry := range entries {
		if !memoryVisibleForRuntime(entry, input) {
			continue
		}
		if !allowedCategory(entry.Category) {
			continue
		}
		if entry.Layer != models.MemoryLayerProject && entry.Layer != models.MemoryLayerGlobal {
			continue
		}
		if hasMemoryTag(entry, "probe") || strings.Contains(strings.ToLower(entry.Title), "probe") {
			continue
		}
		score, reasons := baselineScore(entry)
		if score <= 0 {
			continue
		}
		claim, hasDetail, fullBytes := claimFields(entry.Content)
		candidates = append(candidates, candidate{item: Item{
			ID:        entry.ID,
			Title:     entry.Title,
			Category:  entry.Category,
			Layer:     entry.Layer,
			Status:    entry.Status,
			UpdatedAt: entry.UpdatedAt,
			Content:   normalizeWhitespace(entry.Content),
			Claim:     claim,
			HasDetail: hasDetail,
			FullBytes: fullBytes,
			Score:     score,
			Retrieval: "session-baseline",
			Reasons:   reasons,
			Tags:      append([]string(nil), entry.Tags...),
		}})
	}
	return candidates
}

func buildHeuristicItems(entries []*models.MemoryEntry, input Input) []candidate {
	candidates := make([]candidate, 0, len(entries))
	for _, entry := range entries {
		if !memoryVisibleForRuntime(entry, input) {
			continue
		}
		if !allowedCategory(entry.Category) {
			continue
		}
		score, reasons, match := scoreEntry(entry, input, true)
		if score <= 0 {
			continue
		}
		claim, hasDetail, fullBytes := claimFields(entry.Content)
		candidates = append(candidates, candidate{item: Item{
			ID:           entry.ID,
			Title:        entry.Title,
			Category:     entry.Category,
			Layer:        entry.Layer,
			Status:       entry.Status,
			UpdatedAt:    entry.UpdatedAt,
			Content:      normalizeWhitespace(entry.Content),
			Claim:        claim,
			HasDetail:    hasDetail,
			FullBytes:    fullBytes,
			Score:        score,
			KeywordMatch: match.fraction,
			Retrieval:    "heuristic-fallback",
			Reasons:      append(reasons, "heuristic-fallback"),
			Tags:         append([]string(nil), entry.Tags...),
		}})
	}
	return candidates
}

func buildHybridItems(hits []hybridCandidate, input Input) []candidate {
	// One memory can come back more than once. It is indexed once per store,
	// and an entry that moved between layers leaves a stale chunk in the store
	// it left: r7upz8, demoted to project, still sits in the global index.
	// mergeStoreMemoryResults keys by store, so both copies survive the engine
	// and resolve to the same entry here. Keep the strongest match per entry,
	// or the same rule is injected twice and paid for twice.
	best := make(map[string]int, len(hits))
	for i, hit := range hits {
		if hit.entry == nil || hit.entry.ID == "" {
			continue
		}
		if j, ok := best[hit.entry.ID]; !ok || hit.semantic > hits[j].semantic {
			best[hit.entry.ID] = i
		}
	}

	candidates := make([]candidate, 0, len(hits))
	for i, hit := range hits {
		if hit.entry == nil || !memoryVisibleForRuntime(hit.entry, input) || !allowedCategory(hit.entry.Category) {
			continue
		}
		if id := hit.entry.ID; id != "" && best[id] != i {
			continue
		}
		if !containsString(hit.matchedBy, "semantic") {
			continue
		}
		// No keyword-overlap gate. Every hit here already matched
		// semantically, and requiring a shared word as well put keyword in
		// FRONT of semantic: "don't use the long dash" was discarded for
		// sharing no word with "em dash", which is precisely the case the
		// semantic layer exists to catch. The score floor below still applies,
		// and with no overlap almost all of the score comes from the semantic
		// boost, so only a genuinely strong semantic match clears it.
		//
		// Relevance is the raw cosine. The engine's fused score is a rank
		// (top result always 1.0, even for "ok cảm ơn"), so adding it as a
		// boost gave every prompt a few near-maximal hits regardless of
		// relevance. Keyword overlap, layer and recency only break ties.
		_, reasons, match := scoreEntry(hit.entry, input, false)
		score := hit.semantic + hybridKeywordTiebreak*match.fraction
		if hit.entry.Layer == models.MemoryLayerProject {
			score += hybridProjectTiebreak
		}
		score += recencyBonus(hit.entry.UpdatedAt) / 12
		reasons = append(reasons, fmt.Sprintf("semantic:%.2f", hit.semantic))
		reasons = append(reasons, "hybrid-retrieval", "semantic-match")
		if containsString(hit.matchedBy, "keyword") {
			reasons = append(reasons, "keyword-match")
		}
		claim, hasDetail, fullBytes := claimFields(hit.entry.Content)
		candidates = append(candidates, candidate{item: Item{
			ID:        hit.entry.ID,
			Title:     hit.entry.Title,
			Category:  hit.entry.Category,
			Layer:     hit.entry.Layer,
			Status:    hit.entry.Status,
			UpdatedAt: hit.entry.UpdatedAt,
			Content:   normalizeWhitespace(hit.entry.Content),
			Claim:     claim,
			HasDetail: hasDetail,
			FullBytes: fullBytes,
			Score:     score,
			Semantic:  hit.semantic,
			Retrieval: "hybrid",
			MatchedBy: append([]string(nil), hit.matchedBy...),
			Reasons:   reasons,
			Tags:      append([]string(nil), hit.entry.Tags...),
		}})
	}
	return candidates
}

func defaultHybridCandidates(store *storage.Store, input Input, limit int) ([]hybridCandidate, bool) {
	if store == nil || strings.TrimSpace(input.UserPrompt) == "" {
		return nil, false
	}
	embedder, vecStore, err := search.InitSemantic(store)
	if err != nil {
		return nil, false
	}
	if embedder != nil {
		defer embedder.Close()
	}
	if vecStore != nil {
		defer vecStore.Close()
	}
	engine := search.NewEngine(store, embedder, vecStore)
	if !engine.SemanticAvailable() {
		return nil, false
	}
	return hybridCandidatesFrom(store, engine, input, limit)
}

// memorySearcher is the part of the search engine the hybrid lookup needs.
type memorySearcher interface {
	SearchWithDegradation(search.SearchOptions) ([]models.SearchResult, *search.SearchDegradation, error)
}

func hybridCandidatesFrom(store *storage.Store, engine memorySearcher, input Input, limit int) ([]hybridCandidate, bool) {
	results, degraded, err := engine.SearchWithDegradation(search.SearchOptions{
		Query:             strings.TrimSpace(input.UserPrompt),
		Type:              "memory",
		Mode:              string(search.ModeHybrid),
		Limit:             limit,
		IncludeHistorical: NormalizeMode(input.Mode) == ModeDebug,
	})
	if err != nil || degraded != nil {
		// A failed search is not an answer. Neither is a search whose semantic
		// leg failed and quietly returned keyword-only hits: those carry no
		// cosine, so the relevance floor drops every one and the prompt gets
		// nothing. Report the semantic layer as unavailable so the caller
		// degrades to keyword matching, as it does when no embedder exists.
		return nil, false
	}
	hits := make([]hybridCandidate, 0, len(results))
	for _, result := range results {
		if result.Type != "memory" || strings.TrimSpace(result.ID) == "" {
			continue
		}
		entry, err := store.Memory.Get(result.ID)
		if err != nil || entry == nil {
			continue
		}
		hits = append(hits, hybridCandidate{
			entry:     entry,
			score:     result.Score,
			semantic:  result.SemanticScore,
			matchedBy: append([]string(nil), result.MatchedBy...),
		})
	}
	return hits, true
}

func InjectSystemPrompt(existingSystem, serialized string) string {
	serialized = strings.TrimSpace(serialized)
	if serialized == "" {
		return existingSystem
	}
	if strings.TrimSpace(existingSystem) == "" {
		return serialized
	}
	return strings.TrimSpace(existingSystem) + "\n\n" + serialized
}

func EncodePackHeader(pack Pack) string {
	preview := struct {
		Runtime string `json:"runtime"`
		Mode    string `json:"mode"`
		Status  string `json:"status"`
		Warning string `json:"warning"`
		Items   []Item `json:"items,omitempty"`
	}{
		Runtime: pack.Runtime,
		Mode:    pack.Mode,
		Status:  pack.Status,
		Warning: pack.Warning,
		Items:   pack.Items,
	}
	data, err := json.Marshal(preview)
	if err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(data)
}

func serializePrefix(runtime string) string {
	prefix := "Knowns Guidance\n"
	if strings.EqualFold(strings.TrimSpace(runtime), "opencode") {
		prefix += silentSupplementalWarning + "\n"
	}
	return prefix + canonicalityWarning + "\n"
}

func serializeKNOWNSSummary(store *storage.Store, remaining int) string {
	if store == nil || remaining <= 0 {
		return ""
	}
	// This block is paid on EVERY prompt, so it buys its one new line by
	// dropping two. The old third bullet repeated canonicalityWarning word for
	// word, and that warning is already printed above every injection; the
	// second was too vague to act on. What replaces them is the only thing an
	// agent needs at the moment it considers writing: what a Memory is for.
	block := "\nKnowns is the repository memory and workflow layer for tasks, docs, templates, references, and reusable knowledge.\n\n- A Memory is a fact the NEXT session needs, written from an outcome you reached. If it only repeats the prompt, do not write it.\n- Use MCP `initial` first when available; use `help(\"tool.*\")` or `help(\"workflow.*\")` for domain details.\n- Use MCP `memory({ action: \"list\" })` before `memory({ action: \"get\" })`, and update an existing entry rather than adding a near-duplicate.\n- If MCP bootstrap is unavailable, use the `knowns` CLI for project context.\n- If you have not checked project readiness yet, call MCP `project({ action: \"status\" })` to see knowledge counts, search state, runtime health, and available capabilities.\n"
	if len(block) <= remaining {
		return block
	}
	if remaining <= 48 {
		return ""
	}
	// Cut at a line boundary, never mid-word. This block is a list of rules;
	// half a rule ending in "..." is not a shorter rule, it is an unreadable
	// one, and it sat directly under memory entries that this change just
	// stopped truncating.
	trimmed := block[:remaining]
	idx := strings.LastIndexByte(trimmed, '\n')
	if idx <= 0 {
		return ""
	}
	trimmed = trimmed[:idx+1]
	// Never emit the header with nothing under it. Memories are what the prompt
	// actually asked for, so this block is the right thing to degrade first, but
	// degrading it to a lone banner line spends bytes on pure noise.
	if !strings.Contains(trimmed, "\n- ") {
		return ""
	}
	return trimmed
}

func serializeItems(items []Item, remaining int, serializedItems *[]Item) string {
	if remaining <= 0 || len(items) == 0 {
		return ""
	}
	var builder strings.Builder
	builder.WriteString("\n")
	remaining--

	// Reserve the elision line before spending anything, sized for the worst
	// case. Announcing that entries were hidden is only useful if the
	// announcement itself cannot be the thing that gets cut, and paying for it
	// up front is what makes the declared budget an actual ceiling instead of a
	// number the last write is allowed to step over.
	reserved := 0
	if len(items) > 1 {
		reserved = len(serializeElision(len(items)))
		if reserved < remaining {
			remaining -= reserved
		} else {
			reserved = 0
		}
	}

	emitted := 0
	elided := 0
	for _, item := range items {
		block := serializeItem(item, remaining)
		if block == "" {
			// A block that does not fit must not stop the ones behind it.
			// `break` here was the reason a prompt matching several memories
			// injected exactly one: the list is ordered by score, so what
			// follows a large entry is usually a SMALLER entry, and every one
			// of them was being discarded to protect budget that had room.
			elided++
			continue
		}
		builder.WriteString(block)
		remaining -= len(block)
		emitted++
		if serializedItems != nil {
			*serializedItems = append(*serializedItems, item)
		}
	}

	if emitted == 0 {
		// Nothing fit. Emit the top match anyway, over budget. From the agent's
		// side a prompt that retrieved memories and then showed none is
		// indistinguishable from having no memory at all, and the budget exists
		// to bound repetition, not to make the feature disappear on its most
		// relevant entry.
		block := buildItemBlock(items[0])
		if block == "" {
			return ""
		}
		builder.WriteString(block)
		elided = len(items) - 1
		if serializedItems != nil {
			*serializedItems = append(*serializedItems, items[0])
		}
	}

	if elided > 0 {
		builder.WriteString(serializeElision(elided))
	}
	return builder.String()
}

// serializeElision names what was left out and how to reach it.
func serializeElision(count int) string {
	noun := "memories"
	if count == 1 {
		noun = "memory"
	}
	return fmt.Sprintf("- %d more matching %s did not fit; list them with memory(action:\"list\")\n", count, noun)
}

func serializeItem(item Item, remaining int) string {
	if remaining <= 0 {
		return ""
	}
	block := buildItemBlock(item)
	// All or nothing. The old path trimmed the body to whatever was left, which
	// produced entries cut mid-sentence: an agent reading half a rule cannot
	// tell that it is half, and a truncated claim is worse than an absent one
	// because it still reads as complete.
	if block == "" || len(block) > remaining {
		return ""
	}
	return block
}

// buildItemBlock renders one entry at full size, with no budget applied.
func buildItemBlock(item Item) string {
	ref := memoryReference(item)
	layer := strings.TrimSpace(item.Layer)
	if layer == "" {
		layer = "unknown"
	}
	category := strings.TrimSpace(item.Category)
	if category == "" {
		category = "uncategorized"
	}
	title := normalizeWhitespace(item.Title)
	if title == "" {
		title = "Untitled memory"
	}
	claim := normalizeWhitespace(item.Claim)
	if claim == "" {
		// Items built by hand, including in tests, carry only Content.
		claim = normalizeWhitespace(item.Content)
	}
	if claim == "" {
		return ""
	}

	header := fmt.Sprintf("- %s [%s/%s] %s%s\n", ref, layer, category, title, serializeItemTrustMetadata(item))
	detail := ""
	if item.HasDetail {
		// Printed ONLY when something was actually held back. On a memory whose
		// claim is its whole body this line would send an agent to fetch a
		// fuller version that does not exist, and one wasted call is enough to
		// teach it to ignore the line everywhere it does matter.
		detail = fmt.Sprintf("\n  full=%db  detail: memory(action:\"get\", id:%q)", item.FullBytes, item.ID)
	}
	return header + "  " + claim + detail + "\n"
}

func serializeItemTrustMetadata(item Item) string {
	parts := make([]string, 0, 2)
	if item.Score > 0 {
		parts = append(parts, fmt.Sprintf("score=%.2f", item.Score))
	}
	status := strings.TrimSpace(item.Status)
	if status == "" {
		status = models.MemoryStatusActive
	}
	trust := "supplemental"
	if status == models.MemoryStatusActive {
		trust = "active"
	} else if status != "" {
		trust = status
	}
	parts = append(parts, "trust="+trust)
	if len(parts) == 0 {
		return ""
	}
	return " (" + strings.Join(parts, "; ") + ")"
}

func memoryReference(item Item) string {
	id := strings.TrimSpace(item.ID)
	if id == "" {
		id = "unknown"
	}
	return "@memory/" + id
}

func trimToByteLimit(text string, maxBytes int) string {
	if maxBytes <= 0 {
		return ""
	}
	if len(text) <= maxBytes {
		return text
	}
	trimmed := text[:maxBytes]
	for !utf8.ValidString(trimmed) && len(trimmed) > 0 {
		trimmed = trimmed[:len(trimmed)-1]
	}
	return trimmed
}

// allowedCategory gates what may be injected.
//
// The write contract lives in models.AllowedMemoryCategories and this used to
// keep a second, drifted copy of it. The two disagreed in both directions:
// `convention` was writable but never injectable, so an active, fully sourced
// entry like sbf2ih could top every search and still never reach an agent;
// `warning` was injectable but not writable. One list, plus an explicit legacy
// set that can only shrink.
func allowedCategory(category string) bool {
	normalized := strings.ToLower(strings.TrimSpace(category))
	if normalized == "" {
		return false
	}
	for _, allowed := range models.AllowedMemoryCategories {
		if normalized == allowed {
			return true
		}
	}
	// Readable, never writable: models.ValidateMemoryCategory rejects both on
	// the write path, so these only cover entries that predate the contract.
	switch normalized {
	case "decision", "warning":
		return true
	}
	return false
}

func promptSkipReason(prompt string) string {
	normalized := strings.Join(strings.Fields(strings.ToLower(strings.TrimSpace(prompt))), " ")
	if normalized == "" {
		return SkipReasonLowSignalPrompt
	}
	if len(normalized) < 3 {
		return SkipReasonLowSignalPrompt
	}
	tokens := tokenRE.FindAllString(models.FoldToASCII(normalized), -1)
	if len(tokens) == 0 {
		return SkipReasonLowSignalPrompt
	}
	if len(tokens) > 2 {
		return ""
	}
	for _, token := range tokens {
		if _, ok := lowSignalPromptTokens[token]; !ok {
			return ""
		}
	}
	return SkipReasonLowSignalPrompt
}

func shouldUseSessionBaseline(actionType, prompt string) bool {
	action := strings.ToLower(strings.TrimSpace(actionType))
	if prompt != "" {
		return false
	}
	switch action {
	case "session-start", "sessionstart", "session.created", "agentspawn":
		return true
	default:
		return false
	}
}

// Baseline tiers. At session start there is no question to be relevant TO, so
// the only thing worth spending the budget on is what holds regardless of what
// the user is about to ask.
//
// The tiers are wide enough to separate cleanly: every commitment outranks
// every context-dependent fact, and layer, recency and tags only order within a
// tier. Ranking used to come from TAGS, and tags are a free-form field, so
// `ipkq69` led only because its author happened to write `style` and
// `preference` on it while `rtsx9j`, `ew4xea` and `2s3q4u` sat at positions 10,
// 11 and 12 out of 12, below every project failure note. Category is the field
// the write path actually validates against models.AllowedMemoryCategories.
const (
	baselinePreferenceWeight = 1.0
	baselineConventionWeight = 0.5
	// baselineTagWeight applies AT MOST ONCE. Counting it per tag is what let a
	// twice-tagged entry outrank an equally important once-tagged one.
	baselineTagWeight = 0.08
)

func baselineScore(entry *models.MemoryEntry) (float64, []string) {
	score := 0.0
	reasons := make([]string, 0, 4)

	switch strings.ToLower(strings.TrimSpace(entry.Category)) {
	case "preference":
		// A commitment the user made. Nothing in the repository can confirm or
		// retire it, and it applies to work that has not been described yet.
		score += baselinePreferenceWeight
		reasons = append(reasons, "user-commitment")
	case "convention":
		score += baselineConventionWeight
		reasons = append(reasons, "project-convention")
	}

	switch entry.Layer {
	case models.MemoryLayerProject:
		score += 0.2
		reasons = append(reasons, "project-baseline")
	case models.MemoryLayerGlobal:
		score += 0.14
		reasons = append(reasons, "global-baseline")
	}
	if bonus := recencyBonus(entry.UpdatedAt); bonus > 0 {
		score += bonus
		reasons = append(reasons, "recent")
	}
	for _, tag := range entry.Tags {
		switch strings.ToLower(strings.TrimSpace(tag)) {
		case "preference", "convention", "style", "runtime-memory", "runtime":
			score += baselineTagWeight
			reasons = append(reasons, "baseline-tag")
			return score, dedupeStrings(reasons)
		}
	}
	return score, dedupeStrings(reasons)
}

func hasMemoryTag(entry *models.MemoryEntry, target string) bool {
	for _, tag := range entry.Tags {
		if strings.EqualFold(strings.TrimSpace(tag), target) {
			return true
		}
	}
	return false
}

func dedupeStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

// keywordMatch counts the prompt's content words found in an entry.
//
// fraction is the share, 0 to 1. It replaced a raw count multiplied by 0.35,
// which grew with every word the prompt added: the same memory scored 0.77 for
// "em dash" and 2.52 for a 117-character paraphrase. A share can only fall when
// unrelated words are added, and scales every entry by the same factor, so
// neither selection nor order depends on how long the prompt is.
type keywordMatch struct {
	overlaps int
	total    int
	fraction float64
}

func scoreEntry(entry *models.MemoryEntry, input Input, requirePromptMatch bool) (float64, []string, keywordMatch) {
	mode := NormalizeMode(input.Mode)
	_ = mode
	promptTokens := uniqueTokens(input.UserPrompt)
	contextTokens := uniqueTokens(
		input.Runtime,
		filepathBase(input.ProjectRoot),
		filepathBase(input.WorkingDir),
		input.ActionType,
	)
	// The claim-boundary marker is a directive, not content. Tokenizing it adds
	// words like "memory" and "detail" to every marked entry, so a migration
	// meant to preserve behaviour would change what matches.
	textTokens := uniqueTokens(entry.Title, entry.Category, strings.Join(entry.Tags, " "), models.StripMemoryDetailMarker(entry.Content))
	textSet := make(map[string]struct{}, len(textTokens))
	for _, token := range textTokens {
		textSet[token] = struct{}{}
	}

	score := 0.0
	reasons := make([]string, 0, 4)
	if entry.Layer == models.MemoryLayerProject {
		score += 0.12
		reasons = append(reasons, "project-scoped")
	} else if entry.Layer == models.MemoryLayerGlobal {
		score += 0.04
		reasons = append(reasons, "global-memory")
	}

	match := keywordMatch{total: len(promptTokens)}
	for _, token := range promptTokens {
		if _, ok := textSet[token]; ok {
			match.overlaps++
		}
	}
	if match.total > 0 {
		match.fraction = float64(match.overlaps) / float64(match.total)
	}
	if match.overlaps == 0 && requirePromptMatch {
		return 0, nil, match
	}
	if match.overlaps > 0 {
		score += match.fraction
		reasons = append(reasons, fmt.Sprintf("keyword-overlap:%d/%d", match.overlaps, match.total))
	}

	contextOverlaps := 0
	for _, token := range contextTokens {
		if _, ok := textSet[token]; ok {
			contextOverlaps++
		}
	}
	if contextOverlaps > 0 {
		score += float64(contextOverlaps) * 0.05
	}
	if tokenMatches(textSet, strings.ToLower(strings.TrimSpace(input.Runtime))) {
		score += 0.08
		reasons = append(reasons, "runtime-match")
	}
	if tokenMatches(textSet, strings.ToLower(strings.TrimSpace(input.ActionType))) {
		score += 0.08
		reasons = append(reasons, "action-match")
	}
	if bonus := recencyBonus(entry.UpdatedAt); bonus > 0 {
		score += bonus
		reasons = append(reasons, "recent")
	}
	return score, reasons, match
}

func retrievalModeForItems(items []Item) string {
	mode := ""
	for _, item := range items {
		retrieval := strings.TrimSpace(item.Retrieval)
		if retrieval == "" {
			continue
		}
		if mode == "" {
			mode = retrieval
			continue
		}
		if mode != retrieval {
			return "mixed"
		}
	}
	return mode
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if strings.EqualFold(strings.TrimSpace(value), target) {
			return true
		}
	}
	return false
}

func recencyBonus(updatedAt time.Time) float64 {
	if updatedAt.IsZero() {
		return 0
	}
	ageDays := time.Since(updatedAt).Hours() / 24
	switch {
	case ageDays <= 7:
		return 0.12
	case ageDays <= 30:
		return 0.06
	case ageDays <= 90:
		return 0.03
	default:
		return 0
	}
}

func filepathBase(path string) string {
	path = strings.ReplaceAll(path, `\\`, "/")
	path = strings.TrimSuffix(path, "/")
	if path == "" {
		return ""
	}
	idx := strings.LastIndex(path, "/")
	if idx == -1 {
		return path
	}
	return path[idx+1:]
}

func tokenMatches(set map[string]struct{}, value string) bool {
	for _, token := range uniqueTokens(value) {
		if _, ok := set[token]; ok {
			return true
		}
	}
	return false
}

func uniqueTokens(parts ...string) []string {
	seen := map[string]struct{}{}
	var tokens []string
	for _, part := range parts {
		// Fold before splitting. tokenRE only knows ASCII letters, so an
		// unfolded "không" split into "kh" and "ng" and both fell under the
		// length filter: Vietnamese content words vanished from matching while
		// ASCII function words like "khi" and "cho" survived to match
		// everything. The same shredding already broke DeriveMemoryKey.
		for _, token := range tokenRE.FindAllString(models.FoldToASCII(part), -1) {
			if len(token) < 3 {
				continue
			}
			if _, stop := matchStopwords[token]; stop {
				continue
			}
			if _, ok := seen[token]; ok {
				continue
			}
			seen[token] = struct{}{}
			tokens = append(tokens, token)
		}
	}
	sort.Strings(tokens)
	return tokens
}

func normalizeWhitespace(s string) string {
	return strings.Join(strings.Fields(strings.TrimSpace(s)), " ")
}

// claimFields derives what gets injected from a stored memory body.
//
// The split must happen on the RAW content: normalizeWhitespace collapses the
// blank lines that separate a claim from its evidence, so anything downstream of
// it has already lost the boundary.
func claimFields(raw string) (claim string, hasDetail bool, fullBytes int) {
	text, detail := models.MemoryClaim(raw)
	// The reported size excludes the marker. The number answers "how much do I
	// gain by fetching this", and a formatting directive is not something the
	// reader gains.
	return normalizeWhitespace(text), detail, len(strings.TrimSpace(models.StripMemoryDetailMarker(raw)))
}

// clearsInjectionFloor reports whether an item matched well enough to inject.
// Each retrieval path is judged on the signal it actually has.
func clearsInjectionFloor(item Item) bool {
	switch item.Retrieval {
	case "hybrid":
		return item.Semantic >= semanticRelevanceFloor
	case "heuristic-fallback":
		return item.KeywordMatch >= keywordRelevanceFloor
	default:
		return true
	}
}

func capItems(candidates []candidate, n int) []Item {
	out := make([]Item, 0, min(len(candidates), n))
	for _, c := range candidates {
		if len(out) >= n {
			break
		}
		out = append(out, c.item)
	}
	return out
}
