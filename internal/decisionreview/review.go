package decisionreview

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
)

const (
	ResultCreated        = "created"
	ResultReviewRequired = "review_required"
	ResultResolved       = "resolved"

	ResolutionSupersedeExisting = "supersede_existing"
	ResolutionCreateDraft       = "create_draft"
	ResolutionLinkAsRelated     = "link_as_related"
	ResolutionRejectNew         = "reject_new"

	MatchDuplicate = "duplicate"
	MatchConflict  = "conflict"

	defaultReviewLimit     = 5
	defaultReviewThreshold = 0.72
)

var AllowedResolutions = []string{
	ResolutionSupersedeExisting,
	ResolutionCreateDraft,
	ResolutionLinkAsRelated,
	ResolutionRejectNew,
}

type SemanticSearchFunc func(candidate *models.DecisionEntry, limit int) ([]Match, error)

type Service struct {
	Store           *storage.Store
	Now             func() time.Time
	SemanticSearch  SemanticSearchFunc
	ReviewThreshold float64
	ReviewLimit     int
}

type AddOptions struct {
	SkipReview bool
	Status     string
}

type ResolveOptions struct {
	Resolution    string
	TargetID      string
	ReplacementID string
	Status        string
}

type Result struct {
	Status             string                `json:"status"`
	Resolution         string                `json:"resolution,omitempty"`
	Candidate          *models.DecisionEntry `json:"candidate,omitempty"`
	Matches            []Match               `json:"matches,omitempty"`
	AllowedResolutions []string              `json:"allowedResolutions,omitempty"`
	Decision           *models.DecisionEntry `json:"decision,omitempty"`
	Superseded         *models.DecisionEntry `json:"superseded,omitempty"`
	Current            *models.DecisionEntry `json:"current,omitempty"`
	ChangedIDs         []string              `json:"changedIds,omitempty"`
}

type Match struct {
	ID        string   `json:"id"`
	Title     string   `json:"title"`
	Status    string   `json:"status,omitempty"`
	Score     float64  `json:"score"`
	Kind      string   `json:"kind,omitempty"`
	MatchedBy []string `json:"matchedBy,omitempty"`
	Snippet   string   `json:"snippet,omitempty"`
	Tags      []string `json:"tags,omitempty"`
}

func New(store *storage.Store) *Service {
	return &Service{Store: store}
}

func (s *Service) Add(candidate *models.DecisionEntry, opts AddOptions) (*Result, error) {
	entry, err := s.normalizeCandidate(candidate, opts.Status)
	if err != nil {
		return nil, err
	}
	if !opts.SkipReview {
		review, err := s.Review(entry)
		if err != nil {
			return nil, err
		}
		if review != nil && len(review.Matches) > 0 {
			return review, nil
		}
	}
	return s.create(entry, ResultCreated, "")
}

func (s *Service) Review(candidate *models.DecisionEntry) (*Result, error) {
	entry, err := s.normalizeCandidate(candidate, "")
	if err != nil {
		return nil, err
	}
	matches := make([]Match, 0)
	if semanticMatches, err := s.semanticMatches(entry); err == nil {
		matches = append(matches, semanticMatches...)
	}
	matches = append(matches, s.lexicalMatches(entry)...)
	matches = mergeMatches(matches, s.threshold())
	if len(matches) == 0 {
		return nil, nil
	}
	if len(matches) > s.limit() {
		matches = matches[:s.limit()]
	}
	return &Result{
		Status:             ResultReviewRequired,
		Candidate:          entry,
		Matches:            matches,
		AllowedResolutions: append([]string(nil), AllowedResolutions...),
	}, nil
}

func (s *Service) Resolve(candidate *models.DecisionEntry, opts ResolveOptions) (*Result, error) {
	if opts.Resolution == "" {
		return nil, fmt.Errorf("resolution is required")
	}
	switch opts.Resolution {
	case ResolutionSupersedeExisting:
		return s.supersedeExisting(candidate, opts)
	case ResolutionCreateDraft:
		input := cloneDecision(candidate)
		if input == nil {
			input = &models.DecisionEntry{}
		}
		input.Status = models.DecisionStatusDraft
		entry, err := s.normalizeCandidate(input, models.DecisionStatusDraft)
		if err != nil {
			return nil, err
		}
		return s.create(entry, ResultResolved, opts.Resolution)
	case ResolutionLinkAsRelated:
		return s.linkAsRelated(candidate, opts)
	case ResolutionRejectNew:
		input := cloneDecision(candidate)
		if input == nil {
			input = &models.DecisionEntry{}
		}
		input.Status = models.DecisionStatusRejected
		entry, err := s.normalizeCandidate(input, models.DecisionStatusRejected)
		if err != nil {
			return nil, err
		}
		return s.create(entry, ResultResolved, opts.Resolution)
	default:
		return nil, fmt.Errorf("unsupported decision review resolution: %s", opts.Resolution)
	}
}

func (s *Service) supersedeExisting(candidate *models.DecisionEntry, opts ResolveOptions) (*Result, error) {
	if err := s.ensureStore(); err != nil {
		return nil, err
	}
	if opts.TargetID == "" {
		return nil, fmt.Errorf("targetId is required for %s", opts.Resolution)
	}
	if _, err := s.Store.Decisions.Get(opts.TargetID); err != nil {
		return nil, err
	}

	newID := opts.ReplacementID
	if newID == "" {
		input := cloneDecision(candidate)
		if input == nil {
			input = &models.DecisionEntry{}
		}
		if input.ID == opts.TargetID {
			input.ID = ""
		}
		if opts.Status != "" {
			if opts.Status != models.DecisionStatusDraft && opts.Status != models.DecisionStatusAccepted {
				return nil, fmt.Errorf("supersede replacement status must be draft or accepted")
			}
			input.Status = opts.Status
		} else if input.Status != "" && input.Status != models.DecisionStatusDraft && input.Status != models.DecisionStatusAccepted {
			return nil, fmt.Errorf("supersede replacement status must be draft or accepted")
		}
		entry, err := s.normalizeCandidate(input, "")
		if err != nil {
			return nil, err
		}
		created, err := s.create(entry, ResultResolved, opts.Resolution)
		if err != nil {
			return nil, err
		}
		newID = created.Decision.ID
	} else if _, err := s.Store.Decisions.Get(newID); err != nil {
		return nil, err
	}

	oldDecision, newDecision, err := s.Store.Decisions.Supersede(opts.TargetID, newID)
	if err != nil {
		return nil, err
	}
	return &Result{
		Status:     ResultResolved,
		Resolution: opts.Resolution,
		Decision:   newDecision,
		Superseded: oldDecision,
		Current:    newDecision,
		ChangedIDs: []string{oldDecision.ID, newDecision.ID},
	}, nil
}

func (s *Service) linkAsRelated(candidate *models.DecisionEntry, opts ResolveOptions) (*Result, error) {
	if err := s.ensureStore(); err != nil {
		return nil, err
	}
	if opts.TargetID == "" {
		return nil, fmt.Errorf("targetId is required for %s", opts.Resolution)
	}
	if _, err := s.Store.Decisions.Get(opts.TargetID); err != nil {
		return nil, err
	}
	input := cloneDecision(candidate)
	if input == nil {
		input = &models.DecisionEntry{}
	}
	if input.ID == opts.TargetID {
		input.ID = ""
	}
	input.Status = models.DecisionStatusDraft
	input.Sources = appendUnique(input.Sources, models.DecisionRef(opts.TargetID))
	entry, err := s.normalizeCandidate(input, models.DecisionStatusDraft)
	if err != nil {
		return nil, err
	}
	return s.create(entry, ResultResolved, opts.Resolution)
}

func (s *Service) create(entry *models.DecisionEntry, status, resolution string) (*Result, error) {
	if err := s.ensureStore(); err != nil {
		return nil, err
	}
	if err := s.Store.Decisions.Create(entry, storage.DecisionCreateOptions{Now: s.now()}); err != nil {
		return nil, err
	}
	result := &Result{Status: status, Decision: entry, ChangedIDs: []string{entry.ID}}
	if resolution != "" {
		result.Resolution = resolution
	}
	return result, nil
}

func (s *Service) normalizeCandidate(candidate *models.DecisionEntry, defaultStatus string) (*models.DecisionEntry, error) {
	if err := s.ensureStore(); err != nil {
		return nil, err
	}
	entry := cloneDecision(candidate)
	if entry == nil {
		entry = &models.DecisionEntry{}
	}
	entry.ID = strings.TrimSpace(entry.ID)
	entry.Title = strings.TrimSpace(entry.Title)
	entry.Status = firstNonEmpty(entry.Status, defaultStatus)
	entry.Content = strings.TrimSpace(entry.Content)
	entry.Context = strings.TrimSpace(entry.Context)
	entry.Decision = strings.TrimSpace(entry.Decision)
	entry.AlternativesConsidered = strings.TrimSpace(entry.AlternativesConsidered)
	entry.Consequences = strings.TrimSpace(entry.Consequences)
	entry.Tags = normalizeStringSlice(entry.Tags)
	entry.Sources = normalizeStringSlice(entry.Sources)
	entry.RelatedDocs = normalizeStringSlice(entry.RelatedDocs)
	entry.RelatedTasks = normalizeStringSlice(entry.RelatedTasks)
	if entry.Title == "" {
		return nil, fmt.Errorf("decision title is required")
	}
	entry.ApplyDecisionDefaults()
	if !models.ValidDecisionStatus(entry.Status) {
		return nil, fmt.Errorf("invalid decision status: %q", entry.Status)
	}
	if entry.ID != "" && !models.ValidDecisionID(entry.ID) {
		return nil, fmt.Errorf("invalid decision ID: %q", entry.ID)
	}
	return entry, nil
}

func (s *Service) ensureStore() error {
	if s == nil || s.Store == nil || s.Store.Decisions == nil {
		return fmt.Errorf("decision store unavailable")
	}
	return nil
}

func (s *Service) semanticMatches(candidate *models.DecisionEntry) ([]Match, error) {
	if s.SemanticSearch != nil {
		return s.SemanticSearch(candidate, s.limit())
	}
	embedder, vecStore, err := search.InitSemantic(s.Store)
	if err != nil {
		return nil, err
	}
	if embedder != nil {
		defer embedder.Close()
	}
	if vecStore != nil {
		defer vecStore.Close()
	}
	engine := search.NewEngine(s.Store, embedder, vecStore)
	results, err := engine.Search(search.SearchOptions{
		Query: candidateSearchText(candidate),
		Type:  "decision",
		Mode:  string(search.ModeSemantic),
		Limit: s.limit(),
	})
	if err != nil {
		return nil, err
	}
	matches := make([]Match, 0, len(results))
	for _, result := range results {
		if result.ID == "" || result.ID == candidate.ID || result.Type != "decision" || result.Score < s.threshold() {
			continue
		}
		entry, err := s.Store.Decisions.Get(result.ID)
		if err != nil || !entry.CurrentForDefaultRetrieval() {
			continue
		}
		matches = append(matches, matchFromEntry(entry, result.Score, MatchDuplicate, append([]string(nil), result.MatchedBy...), result.Snippet))
	}
	return matches, nil
}

func (s *Service) lexicalMatches(candidate *models.DecisionEntry) []Match {
	entries, err := s.Store.Decisions.List()
	if err != nil {
		return nil
	}
	matches := make([]Match, 0)
	for _, entry := range entries {
		if entry.ID == candidate.ID || !entry.CurrentForDefaultRetrieval() {
			continue
		}
		score, kind, reasons := lexicalScore(candidate, entry)
		if score < s.threshold() {
			continue
		}
		matches = append(matches, matchFromEntry(entry, score, kind, reasons, candidateSnippet(entry)))
	}
	sortMatches(matches)
	return matches
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Service) threshold() float64 {
	if s.ReviewThreshold > 0 {
		return s.ReviewThreshold
	}
	return defaultReviewThreshold
}

func (s *Service) limit() int {
	if s.ReviewLimit > 0 {
		return s.ReviewLimit
	}
	return defaultReviewLimit
}

func lexicalScore(candidate, existing *models.DecisionEntry) (float64, string, []string) {
	candidateTitle := normalizedText(candidate.Title)
	existingTitle := normalizedText(existing.Title)
	candidateDecision := normalizedText(decisionBodyText(candidate))
	existingDecision := normalizedText(decisionBodyText(existing))
	candidateAll := normalizedText(candidateSearchText(candidate))
	existingAll := normalizedText(candidateSearchText(existing))

	best := 0.0
	kind := ""
	var reasons []string
	if candidateTitle != "" && candidateTitle == existingTitle {
		best = math.Max(best, 0.98)
		kind = MatchDuplicate
		reasons = append(reasons, "lexical:title")
	}
	if candidateDecision != "" && candidateDecision == existingDecision {
		best = math.Max(best, 1.0)
		kind = MatchDuplicate
		reasons = append(reasons, "lexical:decision")
	}
	for label, score := range map[string]float64{
		"lexical:title_tokens":    tokenSimilarity(candidateTitle, existingTitle),
		"lexical:decision_tokens": tokenSimilarity(candidateDecision, existingDecision),
		"lexical:combined":        tokenSimilarity(candidateAll, existingAll),
	} {
		if score > best {
			best = score
		}
		if score >= defaultReviewThreshold {
			if kind == "" {
				kind = MatchDuplicate
			}
			reasons = append(reasons, label)
		}
	}

	if overlap, ok := conflictTopicOverlap(candidateTitle, existingTitle); ok {
		best = math.Max(best, 0.82+math.Min(float64(overlap-2)*0.03, 0.09))
		if kind == "" {
			kind = MatchConflict
		}
		reasons = append(reasons, "lexical:conflict_topic")
	}
	if kind == "" && best >= defaultReviewThreshold {
		kind = MatchDuplicate
		reasons = append(reasons, "lexical")
	}
	return best, kind, reasons
}

func conflictTopicOverlap(a, b string) (int, bool) {
	left := significantTokenSet(a)
	right := significantTokenSet(b)
	if len(left) == 0 || len(right) == 0 {
		return 0, false
	}
	overlap := 0
	for token := range left {
		if right[token] {
			overlap++
		}
	}
	return overlap, overlap >= 2 && strings.TrimSpace(a) != strings.TrimSpace(b)
}

func tokenSimilarity(a, b string) float64 {
	left := tokenSet(a)
	right := tokenSet(b)
	if len(left) == 0 || len(right) == 0 {
		return 0
	}
	intersection := 0
	for token := range left {
		if right[token] {
			intersection++
		}
	}
	union := len(left) + len(right) - intersection
	if union == 0 {
		return 0
	}
	return float64(intersection) / float64(union)
}

func tokenSet(text string) map[string]bool {
	tokens := strings.FieldsFunc(strings.ToLower(text), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
	out := make(map[string]bool, len(tokens))
	for _, token := range tokens {
		if len(token) < 3 {
			continue
		}
		out[token] = true
	}
	return out
}

func significantTokenSet(text string) map[string]bool {
	tokens := tokenSet(text)
	for _, stop := range []string{"and", "are", "but", "for", "from", "new", "old", "our", "the", "this", "that", "use", "uses", "using", "with"} {
		delete(tokens, stop)
	}
	return tokens
}

func mergeMatches(matches []Match, threshold float64) []Match {
	byID := make(map[string]Match, len(matches))
	for _, match := range matches {
		if match.ID == "" || match.Score < threshold {
			continue
		}
		existing, ok := byID[match.ID]
		if !ok || match.Score > existing.Score {
			match.MatchedBy = appendUnique(existing.MatchedBy, match.MatchedBy...)
			byID[match.ID] = match
			continue
		}
		existing.MatchedBy = appendUnique(existing.MatchedBy, match.MatchedBy...)
		byID[match.ID] = existing
	}
	merged := make([]Match, 0, len(byID))
	for _, match := range byID {
		merged = append(merged, match)
	}
	sortMatches(merged)
	return merged
}

func sortMatches(matches []Match) {
	sort.SliceStable(matches, func(i, j int) bool {
		if matches[i].Score != matches[j].Score {
			return matches[i].Score > matches[j].Score
		}
		return matches[i].Title < matches[j].Title
	})
}

func matchFromEntry(entry *models.DecisionEntry, score float64, kind string, matchedBy []string, snippet string) Match {
	return Match{
		ID:        entry.ID,
		Title:     entry.Title,
		Status:    entry.Status,
		Score:     score,
		Kind:      kind,
		MatchedBy: matchedBy,
		Snippet:   truncate(strings.TrimSpace(snippet), 220),
		Tags:      append([]string(nil), entry.Tags...),
	}
}

func cloneDecision(entry *models.DecisionEntry) *models.DecisionEntry {
	if entry == nil {
		return nil
	}
	clone := *entry
	clone.Supersedes = append([]string(nil), entry.Supersedes...)
	clone.SupersededBy = append([]string(nil), entry.SupersededBy...)
	clone.Tags = append([]string(nil), entry.Tags...)
	clone.Sources = append([]string(nil), entry.Sources...)
	clone.RelatedDocs = append([]string(nil), entry.RelatedDocs...)
	clone.RelatedTasks = append([]string(nil), entry.RelatedTasks...)
	return &clone
}

func candidateSearchText(entry *models.DecisionEntry) string {
	if entry == nil {
		return ""
	}
	return strings.TrimSpace(strings.Join([]string{
		entry.Title,
		strings.Join(entry.Tags, " "),
		strings.Join(entry.Sources, " "),
		strings.Join(entry.RelatedDocs, " "),
		strings.Join(entry.RelatedTasks, " "),
		decisionBodyText(entry),
	}, "\n"))
}

func decisionBodyText(entry *models.DecisionEntry) string {
	if entry == nil {
		return ""
	}
	return strings.TrimSpace(strings.Join([]string{
		entry.Decision,
		entry.Context,
		entry.AlternativesConsidered,
		entry.Consequences,
		entry.Content,
	}, "\n"))
}

func candidateSnippet(entry *models.DecisionEntry) string {
	text := decisionBodyText(entry)
	if text != "" {
		return text
	}
	return entry.Title
}

func normalizedText(text string) string {
	return strings.Join(strings.Fields(strings.ToLower(strings.TrimSpace(text))), " ")
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func normalizeStringSlice(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			out = append(out, value)
		}
	}
	return out
}

func appendUnique(existing []string, values ...string) []string {
	seen := make(map[string]bool, len(existing)+len(values))
	out := make([]string, 0, len(existing)+len(values))
	for _, value := range existing {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func truncate(text string, maxLen int) string {
	if maxLen <= 0 || len(text) <= maxLen {
		return text
	}
	if maxLen <= 3 {
		return text[:maxLen]
	}
	return text[:maxLen-3] + "..."
}
