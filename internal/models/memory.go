package models

import (
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
)

var memoryIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

// Memory layer constants.
const (
	MemoryLayerProject = "project"
	MemoryLayerGlobal  = "global"
)

// MemoryEntry represents a single memory entry stored as a markdown file
// with YAML frontmatter. Content is free-form markdown.
type MemoryEntry struct {
	ID    string `json:"id"                    yaml:"id"`
	Title string `json:"title"                 yaml:"title"`

	// Key is the upsert handle, unique within a Layer. Writing with a Key that
	// already exists updates that entry in place instead of adding a second one.
	// Defaults to DeriveMemoryKey(Title). Unlike ID it may change, so nothing
	// should reference an entry by Key.
	Key string `json:"key,omitempty" yaml:"key,omitempty"`

	Layer    string `json:"layer"                 yaml:"layer"`              // "project", "global"
	Category string `json:"category,omitempty"    yaml:"category,omitempty"` // "pattern", "convention", "preference", etc.; "decision" is legacy.

	// Content holds the markdown body. Not persisted in frontmatter.
	Content string `json:"content,omitempty" yaml:"-"`

	Status         string            `json:"status,omitempty"         yaml:"status,omitempty"`
	Confidence     string            `json:"confidence,omitempty"     yaml:"confidence,omitempty"`
	LastVerified   time.Time         `json:"lastVerified,omitempty"   yaml:"lastVerified,omitempty"`
	TTLDays        int               `json:"ttlDays,omitempty"        yaml:"ttlDays,omitempty"`
	Sources        []string          `json:"sources,omitempty"        yaml:"sources,omitempty"`
	MergedInto     string            `json:"mergedInto,omitempty"     yaml:"mergedInto,omitempty"`
	RejectedReason string            `json:"rejectedReason,omitempty" yaml:"rejectedReason,omitempty"`
	Tags           []string          `json:"tags,omitempty"           yaml:"tags,omitempty"`
	Metadata       map[string]string `json:"metadata,omitempty"       yaml:"metadata,omitempty"`
	CreatedAt      time.Time         `json:"createdAt"                yaml:"createdAt"`
	UpdatedAt      time.Time         `json:"updatedAt"                yaml:"updatedAt"`

	// LifecycleMetadataMissing tracks absent lifecycle frontmatter on legacy files.
	// It is not persisted; validators use it to warn while loading legacy entries as active.
	LifecycleMetadataMissing []string `json:"lifecycleMetadataMissing,omitempty" yaml:"-"`
}

const (
	MemoryStatusProposed   = "proposed"
	MemoryStatusActive     = "active"
	MemoryStatusStale      = "stale"
	MemoryStatusDeprecated = "deprecated"
	MemoryStatusArchived   = "archived"
	MemoryStatusRejected   = "rejected"
	MemoryStatusMerged     = "merged"
)

const (
	MemoryConfidenceLow    = "low"
	MemoryConfidenceMedium = "medium"
	MemoryConfidenceHigh   = "high"
)

const LegacyDecisionMemoryCategory = "decision"

const (
	LegacyDecisionMigrationIDKey         = "decisionMigration.id"
	LegacyDecisionMigrationResolutionKey = "decisionMigration.resolution"
	LegacyDecisionMigrationDecisionKey   = "decisionMigration.decisionId"
)

var ErrLegacyDecisionMemoryWrite = errors.New("memory category \"decision\" is legacy and read-only; archive, reject, reclassify, or migrate existing entries, and create new durable guidance as a first-class System Decision with `knowns decision create` or the Decision MCP/API")

// IsLegacyDecisionMemoryCategory normalizes user input before applying the
// legacy category policy at every Memory write boundary.
func IsLegacyDecisionMemoryCategory(category string) bool {
	return strings.EqualFold(strings.TrimSpace(category), LegacyDecisionMemoryCategory)
}

// ValidateNewMemoryCategory rejects all new Decision Memory writes. Historical
// files remain readable and are handled by ValidateLegacyDecisionMemoryUpdate.
func ValidateNewMemoryCategory(category string) error {
	if IsLegacyDecisionMemoryCategory(category) {
		return ErrLegacyDecisionMemoryWrite
	}
	return nil
}

// ValidateLegacyDecisionMemoryUpdate constrains historical Decision Memories
// to terminal lifecycle changes or reclassification. Migration records use an
// archived legacy entry plus provenance rather than mutating current guidance.
func ValidateLegacyDecisionMemoryUpdate(existing, updated *MemoryEntry) error {
	if existing == nil || updated == nil {
		return nil
	}
	wasLegacy := IsLegacyDecisionMemoryCategory(existing.Category)
	isLegacy := IsLegacyDecisionMemoryCategory(updated.Category)
	if !wasLegacy {
		return ValidateNewMemoryCategory(updated.Category)
	}
	if !isLegacy {
		return nil
	}
	if updated.Status == MemoryStatusArchived || updated.Status == MemoryStatusRejected {
		return nil
	}
	return ErrLegacyDecisionMemoryWrite
}

func ValidMemoryStatus(status string) bool {
	switch status {
	case MemoryStatusProposed, MemoryStatusActive, MemoryStatusStale,
		MemoryStatusDeprecated, MemoryStatusArchived, MemoryStatusRejected,
		MemoryStatusMerged:
		return true
	default:
		return false
	}
}

func ValidMemoryConfidence(confidence string) bool {
	switch confidence {
	case MemoryConfidenceLow, MemoryConfidenceMedium, MemoryConfidenceHigh:
		return true
	default:
		return false
	}
}

// AllowedMemoryCategories is the contract kn-extract already publishes:
// "Use only pattern, convention, preference, or failure categories."
//
// The store predates the rule and holds entries outside it: one
// `implementation`, one `failure-pattern` and one legacy `decision`. Those stay
// readable; only new writes are held to the list, so a migration can reclassify
// them without a flag day.
var AllowedMemoryCategories = []string{"pattern", "convention", "preference", "failure"}

// ValidateMemoryCategory rejects a category the write path should never create.
//
// An empty category stays legal because callers that never set one, including
// older CLI invocations, must keep working. The whitelist is only applied to a
// value the caller actually chose.
func ValidateMemoryCategory(category string) error {
	trimmed := strings.TrimSpace(category)
	if trimmed == "" {
		return nil
	}
	if err := ValidateNewMemoryCategory(trimmed); err != nil {
		return err
	}
	for _, allowed := range AllowedMemoryCategories {
		if strings.EqualFold(trimmed, allowed) {
			return nil
		}
	}
	return fmt.Errorf("memory category %q is not allowed; use one of %s", trimmed, strings.Join(AllowedMemoryCategories, ", "))
}

// whyMarker is the heading a preference Memory must carry.
const whyMarker = "**Why:**"

// ValidatePreferenceWhy requires a `preference` Memory to record why it exists.
//
// A preference is a COMMITMENT, not a claim about the code: nothing outside the
// user's own words makes it true, so there is no source to re-read when it has
// to be applied to a situation it did not anticipate. The reason is the only
// thing that lets a rule be extended correctly. "No em dash" cannot tell you
// whether it covers a string literal; "no em dash, because it reads as
// machine-written" answers that on its own.
//
// The three preferences that predate this rule stay readable and keep being
// injected. `knowns validate` reports them through MissingTrustMetadata rather
// than this function, because retrofitting a reason is the user's call and
// nobody else can supply it honestly.
func ValidatePreferenceWhy(category, content string) error {
	if !strings.EqualFold(strings.TrimSpace(category), "preference") {
		return nil
	}
	if strings.Contains(content, whyMarker) {
		return nil
	}
	return fmt.Errorf("a preference memory must state its reason: add a %s line saying why the user asked for this, since the reason is what lets the rule be applied to cases it does not name", whyMarker)
}

// MemoryDetailMarker separates the claim an agent is shown from the reasoning
// and supporting material it can fetch on demand.
//
// A memory has three parts: the claim, the reason it exists, and whatever
// supplementary material makes it usable. Only the claim has to be paid for on
// every prompt. The other two are what an agent goes and reads once it decides
// the claim applies to what it is doing.
const MemoryDetailMarker = "<!--memory:detail-->"

// MemoryClaim returns the part of a memory worth injecting, and whether
// anything was held back.
//
// With the marker present the split is explicit. Without it the claim is the
// first paragraph, which is why the twelve entries already in the store work
// unchanged: they were written with the point in the opening paragraph and the
// evidence below it. That fallback is a convention, not a guarantee, so
// `hasDetail` reports what actually happened rather than what was intended.
//
// hasDetail is false when the claim IS the whole content. A short memory must
// not invite an agent to go fetch a fuller version that does not exist; the
// wasted call teaches it to distrust the line everywhere else.
func MemoryClaim(content string) (string, bool) {
	trimmed := strings.TrimSpace(content)
	if trimmed == "" {
		return "", false
	}
	if idx := strings.Index(trimmed, MemoryDetailMarker); idx >= 0 {
		claim := strings.TrimSpace(trimmed[:idx])
		rest := strings.TrimSpace(trimmed[idx+len(MemoryDetailMarker):])
		// An empty claim means the marker leads the content. Falling back to the
		// paragraph split would inject the detail as if it were the claim, so
		// treat the whole body as the claim and admit there is no detail.
		if claim == "" {
			return trimmed, false
		}
		return claim, rest != ""
	}
	claim := firstParagraph(trimmed)
	return claim, len(claim) < len(trimmed)
}

// firstParagraph cuts at the first blank line, tolerating carriage returns and
// trailing spaces on the blank line itself.
func firstParagraph(text string) string {
	lines := strings.Split(text, "\n")
	end := len(lines)
	for i, line := range lines {
		if i > 0 && strings.TrimSpace(strings.TrimSuffix(line, "\r")) == "" {
			end = i
			break
		}
	}
	return strings.TrimSpace(strings.Join(lines[:end], "\n"))
}

var memoryKeyNonSlugRE = regexp.MustCompile(`[^a-z0-9]+`)

// DeriveMemoryKey turns a title into the key used for upsert.
//
// The key comes from the TITLE and never from the content, so editing a
// memory's body does not re-key it. Deriving it from content is what lets a
// reworded insight land as a second entry, which is how a store accumulates
// near-duplicates that no exact-match check will ever catch.
//
// This is deliberately not the entry's identity. The ID stays random because
// `@memory/<id>` refs already exist in the store and in shipped instructions;
// a content-derived identity would break every one of them on the first edit.
func DeriveMemoryKey(title string) string {
	slug := memoryKeyNonSlugRE.ReplaceAllString(strings.ToLower(strings.TrimSpace(title)), "-")
	slug = strings.Trim(slug, "-")
	if len(slug) > 80 {
		slug = strings.Trim(slug[:80], "-")
	}
	return slug
}

func (m *MemoryEntry) ApplyLifecycleDefaults() {
	if m.Status == "" {
		m.Status = MemoryStatusActive
	}
}

func (m *MemoryEntry) MissingTrustMetadata() []string {
	seen := make(map[string]bool)
	var missing []string
	add := func(field string) {
		if field == "" || seen[field] {
			return
		}
		seen[field] = true
		missing = append(missing, field)
	}
	for _, field := range m.LifecycleMetadataMissing {
		add(field)
	}
	if m.Status == "" {
		add("status")
	}
	if m.Confidence == "" {
		add("confidence")
	}
	if m.LastVerified.IsZero() {
		add("lastVerified")
	}
	if m.TTLDays <= 0 {
		add("ttlDays")
	}
	if len(m.Sources) == 0 {
		add("sources")
	}
	return missing
}

func (m *MemoryEntry) CurrentForDefaultRetrieval() bool {
	if m == nil {
		return false
	}
	status := m.Status
	if status == "" {
		status = MemoryStatusActive
	}
	return status == MemoryStatusActive
}

// MemoryFileName returns the canonical file name for a memory entry.
//
// Format: "memory-{id}.md"
func MemoryFileName(id string) string {
	return "memory-" + id + ".md"
}

// ValidateMemoryID rejects IDs that can change the canonical memory filename
// or use platform-specific alternate path syntax.
func ValidateMemoryID(id string) error {
	if !memoryIDPattern.MatchString(id) || strings.HasSuffix(id, ".") {
		return fmt.Errorf("invalid memory ID %q", id)
	}
	return nil
}

// ValidMemoryLayer reports whether layer is a recognised memory layer.
func ValidMemoryLayer(layer string) bool {
	return layer == MemoryLayerProject || layer == MemoryLayerGlobal
}

// ValidPersistentMemoryLayer reports whether layer is a persistent memory layer.
func ValidPersistentMemoryLayer(layer string) bool {
	return layer == MemoryLayerProject || layer == MemoryLayerGlobal
}

// PromoteLayer returns the next layer up, or an error string if already at top.
func PromoteLayer(layer string) (string, bool) {
	switch layer {
	case MemoryLayerProject:
		return MemoryLayerGlobal, true
	default:
		return "", false
	}
}

// DemoteLayer returns the next layer down, or an error string if already at bottom.
func DemoteLayer(layer string) (string, bool) {
	switch layer {
	case MemoryLayerGlobal:
		return MemoryLayerProject, true
	default:
		return "", false
	}
}

// PromotePersistentMemoryLayer returns the next persistent layer up.
func PromotePersistentMemoryLayer(layer string) (string, bool) {
	switch layer {
	case MemoryLayerProject:
		return MemoryLayerGlobal, true
	default:
		return "", false
	}
}

// DemotePersistentMemoryLayer returns the next persistent layer down.
func DemotePersistentMemoryLayer(layer string) (string, bool) {
	switch layer {
	case MemoryLayerGlobal:
		return MemoryLayerProject, true
	default:
		return "", false
	}
}

// MemoryProposalTTLDays is how long a `proposed` entry may sit unresolved.
//
// A proposal nobody acts on inside this window is a proposal that was not
// needed. Left alone it becomes the worst of both states: never retrieved, so
// it helps nothing, and never removed, so it keeps crowding the review queue
// that a person would have to read to find the entries that do matter.
const MemoryProposalTTLDays = 30

// memoryProposalTTLEffectiveFrom is the day the review queue started being
// reported and expired. Proposals older than this are measured from here, so a
// backlog built under a system that never announced itself gets the same full
// window as anything written afterwards. See ProposalIsExpired.
var memoryProposalTTLEffectiveFrom = time.Date(2026, 9, 9, 0, 0, 0, 0, time.UTC)

// Cleanup candidate kinds. The distinction is the point: an abandoned proposal
// and a merely old entry need opposite treatment, and reporting them as one
// list is what let a working `active` memory be offered for deletion beside a
// proposal nobody ever looked at.
const (
	MemoryCleanupAbandonedProposal = "abandoned-proposal"
	MemoryCleanupStaleEntry        = "stale-entry"
)

// MemoryCleanupCandidate is one entry offered for review or removal.
type MemoryCleanupCandidate struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Layer     string    `json:"layer"`
	Category  string    `json:"category,omitempty"`
	Status    string    `json:"status,omitempty"`
	Kind      string    `json:"kind"`
	Tags      []string  `json:"tags,omitempty"`
	Content   string    `json:"content"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	AgeDays   int       `json:"ageDays"`
}

// MemoryEffectiveUpdatedAt is the timestamp age is measured from.
func MemoryEffectiveUpdatedAt(entry *MemoryEntry) time.Time {
	if entry == nil {
		return time.Time{}
	}
	if !entry.UpdatedAt.IsZero() {
		return entry.UpdatedAt
	}
	return entry.CreatedAt
}

// ProposalIsExpired reports whether a `proposed` entry has outlived the queue.
//
// Only `proposed` expires. Every other status is either in use or already
// terminal, and sweeping those would delete knowledge rather than clear a
// backlog.
func ProposalIsExpired(entry *MemoryEntry, ttlDays int, now time.Time) bool {
	if entry == nil || entry.Status != MemoryStatusProposed {
		return false
	}
	if ttlDays <= 0 {
		ttlDays = MemoryProposalTTLDays
	}
	effective := MemoryEffectiveUpdatedAt(entry)
	if effective.IsZero() {
		return false
	}
	// A PROPOSAL CANNOT HAVE BEEN ABANDONED BEFORE ANYTHING ANNOUNCED IT.
	//
	// The backlog that existed when this rule shipped had accumulated under a
	// system that never surfaced the queue: nothing expired an entry and nothing
	// counted it, so a person could work in the repository daily for months and
	// never learn that 48 entries were waiting. Measuring their age from when
	// they were written would retire them for missing a deadline that did not
	// exist, and it would take real knowledge with it. This store held six
	// well-sourced failures and a root-cause writeup in that state.
	//
	// So the clock starts at the later of the entry's own timestamp and the day
	// the rule took effect. Everything written afterwards is measured normally,
	// because from then on the count is reported at every session start.
	//
	// This is deliberately a fixed date rather than persisted state: it needs no
	// migration, it cannot drift between machines, and once the grace window has
	// passed it stops having any effect and can simply be deleted.
	if effective.Before(memoryProposalTTLEffectiveFrom) {
		effective = memoryProposalTTLEffectiveFrom
	}
	return effective.Before(now.Add(-time.Duration(ttlDays) * 24 * time.Hour))
}

// SelectMemoryCleanupCandidates is the ONE selection rule for cleanup.
//
// It replaces two copies, one in internal/cli and one in internal/mcp/handlers,
// that had already drifted: the MCP copy applied defaults for olderThanDays and
// limit and the CLI copy did not, so the same request answered differently
// depending on which door it came through. Neither read Status, which is why a
// verified `active` memory could be listed for cleanup purely for being old.
func SelectMemoryCleanupCandidates(entries []*MemoryEntry, olderThanDays, limit int, now time.Time) []MemoryCleanupCandidate {
	if olderThanDays <= 0 {
		olderThanDays = 7
	}
	if limit <= 0 {
		limit = 20
	}
	threshold := now.Add(-time.Duration(olderThanDays) * 24 * time.Hour)

	candidates := make([]MemoryCleanupCandidate, 0)
	for _, entry := range entries {
		if entry == nil {
			continue
		}
		effective := MemoryEffectiveUpdatedAt(entry)
		if effective.IsZero() {
			continue
		}

		kind := ""
		switch {
		case ProposalIsExpired(entry, MemoryProposalTTLDays, now):
			kind = MemoryCleanupAbandonedProposal
		case effective.Before(threshold):
			kind = MemoryCleanupStaleEntry
		default:
			continue
		}

		candidates = append(candidates, MemoryCleanupCandidate{
			ID:        entry.ID,
			Title:     entry.Title,
			Layer:     entry.Layer,
			Category:  entry.Category,
			Status:    entry.Status,
			Kind:      kind,
			Tags:      entry.Tags,
			Content:   entry.Content,
			CreatedAt: entry.CreatedAt,
			UpdatedAt: entry.UpdatedAt,
			AgeDays:   int(now.Sub(effective).Hours() / 24),
		})
	}

	// Abandoned proposals first: they are the ones that can be cleared without
	// judgement, and burying them under old-but-working entries is what made the
	// existing report something nobody acted on.
	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].Kind != candidates[j].Kind {
			return candidates[i].Kind == MemoryCleanupAbandonedProposal
		}
		return candidates[i].AgeDays > candidates[j].AgeDays
	})
	if len(candidates) > limit {
		candidates = candidates[:limit]
	}
	return candidates
}
