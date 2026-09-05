package storage

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"gopkg.in/yaml.v3"
)

// DecisionStore reads and writes decision files from .knowns/decisions/.
type DecisionStore struct {
	root          string
	lifecycleLock *decisionLifecycleLock
	writeFile     func(string, []byte) error
}

// CanonicalDecisionHash identifies the substance a reviewer judged: the
// decision's own content and relationships, with every review field and
// timestamp excluded. Excluding them is what makes the hash usable as a review
// watermark; if writing the review changed the hash, the review would be stale
// the instant it was recorded.
func CanonicalDecisionHash(entry *models.DecisionEntry) string {
	if entry == nil {
		return ""
	}
	// ID is deliberately absent. It is assigned inside Create, after the review
	// that records this hash has already run, so including it guaranteed a
	// mismatch on every freshly created decision. It also never changes, so it
	// tells a change detector nothing.
	return hashSnapshot(map[string]any{
		"title": entry.Title, "status": entry.Status,
		"supersedes": canonicalList(entry.Supersedes), "supersededBy": canonicalList(entry.SupersededBy),
		"tags": canonicalList(entry.Tags), "sources": canonicalList(entry.Sources),
		"relatedDocs": canonicalList(entry.RelatedDocs), "relatedTasks": canonicalList(entry.RelatedTasks),
		"verification": canonicalList(entry.Verification), "verifiedAt": entry.VerifiedAt,
		// The body is hashed in its canonical rendered form, the same one the
		// store writes. Hashing the section fields and Content separately does
		// not round-trip: on write the sections are set and Content is empty,
		// while on read Content holds the rendered body. It also loses body
		// text that lives outside the four known sections.
		"body": renderDecisionBody(entry),
	})
}

// canonicalList collapses an empty slice and a nil slice to one value. The
// write path builds empty slices while the YAML reader leaves them nil, and
// without this every freshly created decision hashed differently on reload and
// reported its own review as stale.
func canonicalList(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	return values
}

// DecisionReviewIsStale reports whether a recorded review was made against a
// state the decision has since left. A review with no recorded state is not
// stale, only unverifiable: it predates the watermark.
func DecisionReviewIsStale(entry *models.DecisionEntry) bool {
	if entry == nil || entry.ReviewEvaluatedHash == "" {
		return false
	}
	return entry.ReviewEvaluatedHash != CanonicalDecisionHash(entry)
}

func (ds *DecisionStore) decisionsDir() string { return filepath.Join(ds.root, "decisions") }

type decisionFrontmatter struct {
	ID                       string                       `yaml:"id"`
	Title                    string                       `yaml:"title"`
	Status                   string                       `yaml:"status"`
	Supersedes               []string                     `yaml:"supersedes,omitempty"`
	SupersededBy             []string                     `yaml:"supersededBy,omitempty"`
	Tags                     []string                     `yaml:"tags,omitempty"`
	Sources                  []string                     `yaml:"sources,omitempty"`
	RelatedDocs              []string                     `yaml:"relatedDocs,omitempty"`
	RelatedTasks             []string                     `yaml:"relatedTasks,omitempty"`
	Verification             []string                     `yaml:"verification,omitempty"`
	VerifiedAt               string                       `yaml:"verifiedAt,omitempty"`
	ReviewState              string                       `yaml:"reviewState,omitempty"`
	ReviewBlockers           []string                     `yaml:"reviewBlockers,omitempty"`
	ReviewMatches            []models.DecisionReviewMatch `yaml:"reviewMatches,omitempty"`
	ReviewAllowedResolutions []string                     `yaml:"reviewAllowedResolutions,omitempty"`
	ReviewEvaluatedAt        string                       `yaml:"reviewEvaluatedAt,omitempty"`
	ReviewEvaluatedHash      string                       `yaml:"reviewEvaluatedHash,omitempty"`
	CreatedAt                string                       `yaml:"createdAt"`
	UpdatedAt                string                       `yaml:"updatedAt"`
}

type DecisionCreateOptions struct {
	Now time.Time
}

// List returns all decisions.
func (ds *DecisionStore) List() ([]*models.DecisionEntry, error) {
	entries, err := os.ReadDir(ds.decisionsDir())
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("list decisions: %w", err)
	}

	var decisions []*models.DecisionEntry
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md") {
			continue
		}
		decision, err := ds.parseFile(filepath.Join(ds.decisionsDir(), entry.Name()))
		if err != nil {
			continue
		}
		decisions = append(decisions, decision)
	}
	sort.Slice(decisions, func(i, j int) bool {
		if decisions[i].CreatedAt.Equal(decisions[j].CreatedAt) {
			return decisions[i].ID < decisions[j].ID
		}
		return decisions[i].CreatedAt.After(decisions[j].CreatedAt)
	})
	return decisions, nil
}

// Get retrieves a decision by ID.
func (ds *DecisionStore) Get(id string) (*models.DecisionEntry, error) {
	if strings.TrimSpace(id) == "" {
		return nil, fmt.Errorf("decision ID is required")
	}
	if !models.ValidDecisionID(id) {
		return nil, fmt.Errorf("invalid decision ID: %q", id)
	}
	absPath := filepath.Join(ds.decisionsDir(), models.DecisionFileName(id))
	if _, err := os.Stat(absPath); err != nil {
		return nil, fmt.Errorf("decision %q not found", id)
	}
	return ds.parseFile(absPath)
}

// Create writes a new decision.
func (ds *DecisionStore) Create(decision *models.DecisionEntry, opts DecisionCreateOptions) error {
	return ds.withLifecycleLock(func() error { return ds.createUnlocked(decision, opts) })
}

func (ds *DecisionStore) createUnlocked(decision *models.DecisionEntry, opts DecisionCreateOptions) error {
	if decision == nil {
		return fmt.Errorf("decision is required")
	}
	if strings.TrimSpace(decision.Title) == "" {
		return fmt.Errorf("decision title is required")
	}

	now := opts.Now
	if now.IsZero() {
		now = time.Now()
	}
	idTime := decision.CreatedAt
	if idTime.IsZero() {
		idTime = now
	}
	persistedNow := now.UTC()
	if decision.CreatedAt.IsZero() {
		decision.CreatedAt = persistedNow
	}
	if decision.UpdatedAt.IsZero() {
		decision.UpdatedAt = persistedNow
	}
	decision.ApplyDecisionDefaults()
	if !models.ValidDecisionStatus(decision.Status) {
		return fmt.Errorf("invalid decision status: %q", decision.Status)
	}
	if !models.ValidDecisionReviewState(decision.ReviewState) {
		return fmt.Errorf("invalid decision review state: %q", decision.ReviewState)
	}
	if decision.ID == "" {
		decision.ID = models.NewDecisionID(decision.Title, idTime, func(id string) bool {
			_, err := os.Stat(filepath.Join(ds.decisionsDir(), models.DecisionFileName(id)))
			return err == nil
		})
	}
	if !models.ValidDecisionID(decision.ID) {
		return fmt.Errorf("invalid decision ID: %q", decision.ID)
	}
	absPath := filepath.Join(ds.decisionsDir(), models.DecisionFileName(decision.ID))
	if _, err := os.Stat(absPath); err == nil {
		return fmt.Errorf("decision %q already exists", decision.ID)
	} else if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("check decision %q: %w", decision.ID, err)
	}

	if err := os.MkdirAll(ds.decisionsDir(), 0o755); err != nil {
		return fmt.Errorf("create decisions dir: %w", err)
	}
	return ds.write(absPath, []byte(renderDecision(decision)))
}

// Update overwrites an existing decision in place.
func (ds *DecisionStore) Update(decision *models.DecisionEntry) error {
	return ds.withLifecycleLock(func() error { return ds.updateUnlocked(decision) })
}

func (ds *DecisionStore) updateUnlocked(decision *models.DecisionEntry) error {
	if decision == nil || strings.TrimSpace(decision.ID) == "" {
		return fmt.Errorf("decision ID is required")
	}
	if !models.ValidDecisionID(decision.ID) {
		return fmt.Errorf("invalid decision ID: %q", decision.ID)
	}
	existing, err := ds.Get(decision.ID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(decision.Title) == "" {
		return fmt.Errorf("decision title is required")
	}
	if decision.CreatedAt.IsZero() {
		decision.CreatedAt = existing.CreatedAt
	}
	decision.UpdatedAt = time.Now().UTC()
	if decision.Status == "" {
		decision.Status = existing.Status
	}
	if !models.ValidDecisionStatus(decision.Status) {
		return fmt.Errorf("invalid decision status: %q", decision.Status)
	}
	if !models.ValidDecisionReviewState(decision.ReviewState) {
		return fmt.Errorf("invalid decision review state: %q", decision.ReviewState)
	}
	return ds.write(filepath.Join(ds.decisionsDir(), models.DecisionFileName(decision.ID)), []byte(renderDecision(decision)))
}

// Link appends related references to a decision.
func (ds *DecisionStore) Link(id string, docs, tasks, sources []string) (*models.DecisionEntry, error) {
	var linked *models.DecisionEntry
	err := ds.withLifecycleLock(func() error {
		decision, err := ds.Get(id)
		if err != nil {
			return err
		}
		decision.RelatedDocs = appendUniqueStrings(decision.RelatedDocs, docs...)
		decision.RelatedTasks = appendUniqueStrings(decision.RelatedTasks, tasks...)
		decision.Sources = appendUniqueStrings(decision.Sources, sources...)
		if err := ds.updateUnlocked(decision); err != nil {
			return err
		}
		linked, err = ds.Get(id)
		return err
	})
	return linked, err
}

// LinkCandidateToCurrent transfers a persisted candidate's provenance to an
// existing current Decision and rejects the duplicate candidate in one
// rollback-safe lifecycle transition.
func (ds *DecisionStore) LinkCandidateToCurrent(candidateID, targetID string, resolvedAt time.Time) (*models.DecisionEntry, *models.DecisionEntry, error) {
	var candidate, target *models.DecisionEntry
	err := ds.withLifecycleLock(func() error {
		var err error
		candidate, err = ds.Get(candidateID)
		if err != nil {
			return err
		}
		target, err = ds.Get(targetID)
		if err != nil {
			return err
		}
		if candidate.ID == target.ID {
			return fmt.Errorf("candidate and target decision must be different")
		}
		candidateRef := models.DecisionRef(candidate.ID)
		targetRef := models.DecisionRef(target.ID)
		if candidate.Status == models.DecisionStatusRejected &&
			decisionStringsContain(candidate.Sources, targetRef) &&
			decisionStringsContain(target.Sources, candidateRef) {
			return nil
		}
		if candidate.Status != models.DecisionStatusDraft {
			return fmt.Errorf("decision %q is not an unresolved draft candidate", candidate.ID)
		}
		if !target.CurrentForDefaultRetrieval() {
			return fmt.Errorf("decision %q is not current accepted guidance", target.ID)
		}
		if resolvedAt.IsZero() {
			resolvedAt = time.Now()
		}
		resolvedAt = resolvedAt.UTC()

		target.Sources = appendUniqueStrings(target.Sources, candidate.Sources...)
		target.Sources = appendUniqueStrings(target.Sources, candidateRef)
		target.RelatedDocs = appendUniqueStrings(target.RelatedDocs, candidate.RelatedDocs...)
		target.RelatedTasks = appendUniqueStrings(target.RelatedTasks, candidate.RelatedTasks...)
		target.UpdatedAt = resolvedAt

		candidate.Status = models.DecisionStatusRejected
		candidate.Sources = appendUniqueStrings(candidate.Sources, targetRef)
		candidate.ReviewState = ""
		candidate.ReviewBlockers = nil
		candidate.ReviewAllowedResolutions = nil
		candidate.UpdatedAt = resolvedAt

		if err := ds.writeDecisionSet(candidate, target); err != nil {
			return err
		}
		candidate, err = ds.Get(candidateID)
		if err != nil {
			return err
		}
		target, err = ds.Get(targetID)
		return err
	})
	return candidate, target, err
}

// RejectCandidate records an explicit terminal rejection. Repeating the same
// resolution is idempotent.
func (ds *DecisionStore) RejectCandidate(id string, resolvedAt time.Time) (*models.DecisionEntry, error) {
	var rejected *models.DecisionEntry
	err := ds.withLifecycleLock(func() error {
		candidate, err := ds.Get(id)
		if err != nil {
			return err
		}
		if candidate.Status == models.DecisionStatusRejected {
			rejected = candidate
			return nil
		}
		if candidate.Status != models.DecisionStatusDraft {
			return fmt.Errorf("decision %q cannot be rejected from status %q", id, candidate.Status)
		}
		if resolvedAt.IsZero() {
			resolvedAt = time.Now()
		}
		candidate.Status = models.DecisionStatusRejected
		candidate.ReviewState = ""
		candidate.ReviewBlockers = nil
		candidate.ReviewAllowedResolutions = nil
		candidate.UpdatedAt = resolvedAt.UTC()
		if err := ds.updateUnlocked(candidate); err != nil {
			return err
		}
		rejected, err = ds.Get(id)
		return err
	})
	return rejected, err
}

// Supersede updates both sides of a decision supersession relationship.
func (ds *DecisionStore) Supersede(oldID, newID string) (*models.DecisionEntry, *models.DecisionEntry, error) {
	var updatedOld, updatedNew *models.DecisionEntry
	err := ds.withLifecycleLock(func() error {
		var err error
		updatedOld, updatedNew, err = ds.supersedeUnlocked(oldID, newID)
		return err
	})
	return updatedOld, updatedNew, err
}

func (ds *DecisionStore) supersedeUnlocked(oldID, newID string) (*models.DecisionEntry, *models.DecisionEntry, error) {
	if oldID == "" || newID == "" {
		return nil, nil, fmt.Errorf("old and new decision IDs are required")
	}
	if oldID == newID {
		return nil, nil, fmt.Errorf("a decision cannot supersede itself")
	}
	oldDecision, err := ds.Get(oldID)
	if err != nil {
		return nil, nil, err
	}
	newDecision, err := ds.Get(newID)
	if err != nil {
		return nil, nil, err
	}

	if oldDecision.Status == models.DecisionStatusSuperseded && decisionStringsContain(oldDecision.SupersededBy, newID) && decisionStringsContain(newDecision.Supersedes, oldID) {
		return oldDecision, newDecision, nil
	}
	if !oldDecision.CurrentForDefaultRetrieval() {
		return nil, nil, fmt.Errorf("decision %q is not current accepted guidance", oldID)
	}
	if !newDecision.CurrentForDefaultRetrieval() {
		return nil, nil, fmt.Errorf("replacement decision %q must be accepted with verified evidence before supersession", newID)
	}
	if decisionStringsContain(oldDecision.Supersedes, newID) {
		return nil, nil, fmt.Errorf("supersession would create a cycle between %q and %q", oldID, newID)
	}

	oldDecision.Status = models.DecisionStatusSuperseded
	oldDecision.SupersededBy = appendUniqueStrings(oldDecision.SupersededBy, newID)
	newDecision.Supersedes = appendUniqueStrings(newDecision.Supersedes, oldID)

	now := time.Now().UTC()
	oldDecision.UpdatedAt = now
	newDecision.UpdatedAt = now

	if err := ds.writeDecisionSet(oldDecision, newDecision); err != nil {
		return nil, nil, err
	}
	updatedOld, err := ds.Get(oldID)
	if err != nil {
		return nil, nil, err
	}
	updatedNew, err := ds.Get(newID)
	if err != nil {
		return nil, nil, err
	}
	return updatedOld, updatedNew, nil
}

// Accept transitions a draft to accepted after the caller has produced trusted
// verification evidence. Optional superseded IDs are updated in the same
// rollback-safe transaction as the replacement.
func (ds *DecisionStore) Accept(id string, verification []string, supersedes []string, verifiedAt time.Time) (*models.DecisionEntry, []*models.DecisionEntry, error) {
	var accepted *models.DecisionEntry
	var replaced []*models.DecisionEntry
	err := ds.withLifecycleLock(func() error {
		decision, err := ds.Get(id)
		if err != nil {
			return err
		}
		if decision.Status != models.DecisionStatusDraft && decision.Status != models.DecisionStatusAccepted {
			return fmt.Errorf("decision %q cannot be accepted from status %q", id, decision.Status)
		}
		verification = appendUniqueStrings(nil, verification...)
		if len(verification) == 0 {
			return fmt.Errorf("verification evidence is required to accept decision %q", id)
		}
		if verifiedAt.IsZero() {
			verifiedAt = time.Now().UTC()
		}
		decision.Status = models.DecisionStatusAccepted
		decision.Verification = verification
		verifiedAt = verifiedAt.UTC()
		decision.VerifiedAt = &verifiedAt
		decision.ReviewState = ""
		decision.ReviewBlockers = nil
		decision.ReviewMatches = nil
		decision.ReviewAllowedResolutions = nil
		decision.ReviewEvaluatedAt = nil
		decision.ReviewEvaluatedHash = ""
		decision.UpdatedAt = verifiedAt

		seen := map[string]bool{}
		changed := []*models.DecisionEntry{decision}
		for _, oldID := range supersedes {
			oldID = strings.TrimSpace(oldID)
			if oldID == "" || seen[oldID] {
				continue
			}
			seen[oldID] = true
			if oldID == id {
				return fmt.Errorf("a decision cannot supersede itself")
			}
			oldDecision, err := ds.Get(oldID)
			if err != nil {
				return err
			}
			if oldDecision.Status == models.DecisionStatusSuperseded && decisionStringsContain(oldDecision.SupersededBy, id) {
				decision.Supersedes = appendUniqueStrings(decision.Supersedes, oldID)
				replaced = append(replaced, oldDecision)
				continue
			}
			if !oldDecision.CurrentForDefaultRetrieval() {
				return fmt.Errorf("decision %q is not current accepted guidance", oldID)
			}
			if decisionStringsContain(oldDecision.Supersedes, id) {
				return fmt.Errorf("supersession would create a cycle between %q and %q", oldID, id)
			}
			oldDecision.Status = models.DecisionStatusSuperseded
			oldDecision.SupersededBy = appendUniqueStrings(oldDecision.SupersededBy, id)
			oldDecision.UpdatedAt = verifiedAt
			decision.Supersedes = appendUniqueStrings(decision.Supersedes, oldID)
			replaced = append(replaced, oldDecision)
			changed = append(changed, oldDecision)
		}
		if err := ds.writeDecisionSet(changed...); err != nil {
			return err
		}
		accepted, err = ds.Get(id)
		if err != nil {
			return err
		}
		for i, old := range replaced {
			loaded, loadErr := ds.Get(old.ID)
			if loadErr != nil {
				return loadErr
			}
			replaced[i] = loaded
		}
		return nil
	})
	return accepted, replaced, err
}

// RollbackLegacyMemoryMigration removes only links owned by a reviewed legacy
// Decision Memory migration. A migration-created draft is deleted; an accepted
// decision is retained as rejected so accepted history is never erased. Any
// supersession relationship makes rollback unsafe and requires manual review.
func (ds *DecisionStore) RollbackLegacyMemoryMigration(id, memoryRef string, created bool, addedSources, addedDocs, addedTasks []string) error {
	return ds.withLifecycleLock(func() error {
		decision, err := ds.Get(id)
		if err != nil {
			return err
		}
		memoryRef = strings.TrimSpace(memoryRef)
		if memoryRef == "" {
			return fmt.Errorf("legacy memory reference is required")
		}

		if created {
			if !decisionStringsContain(decision.Tags, "legacy-memory-migration") || !decisionStringsContain(decision.Sources, memoryRef) {
				return fmt.Errorf("decision %q is not owned by migration source %q", id, memoryRef)
			}
			if len(decision.Supersedes) > 0 || len(decision.SupersededBy) > 0 || decision.Status == models.DecisionStatusSuperseded {
				return fmt.Errorf("decision %q has supersession relationships; automatic migration rollback is unsafe", id)
			}
			switch decision.Status {
			case models.DecisionStatusDraft:
				path := filepath.Join(ds.decisionsDir(), models.DecisionFileName(id))
				if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
					return fmt.Errorf("remove migration draft %q: %w", id, err)
				}
				return nil
			case models.DecisionStatusAccepted:
				decision.Status = models.DecisionStatusRejected
				decision.Verification = nil
				decision.VerifiedAt = nil
				return ds.updateUnlocked(decision)
			case models.DecisionStatusRejected, models.DecisionStatusArchived:
				return nil
			default:
				return fmt.Errorf("decision %q has status %q; automatic migration rollback is unsafe", id, decision.Status)
			}
		}

		updated := false
		decision.Sources, updated = removeDecisionMigrationValues(decision.Sources, addedSources, updated)
		decision.RelatedDocs, updated = removeDecisionMigrationValues(decision.RelatedDocs, addedDocs, updated)
		decision.RelatedTasks, updated = removeDecisionMigrationValues(decision.RelatedTasks, addedTasks, updated)
		if !updated {
			return nil
		}
		return ds.updateUnlocked(decision)
	})
}

func removeDecisionMigrationValues(existing, owned []string, changed bool) ([]string, bool) {
	if len(existing) == 0 || len(owned) == 0 {
		return existing, changed
	}
	remove := make(map[string]bool, len(owned))
	for _, value := range owned {
		if value = strings.TrimSpace(value); value != "" {
			remove[value] = true
		}
	}
	kept := make([]string, 0, len(existing))
	for _, value := range existing {
		if remove[strings.TrimSpace(value)] {
			changed = true
			continue
		}
		kept = append(kept, value)
	}
	return kept, changed
}

func (ds *DecisionStore) write(path string, data []byte) error {
	if ds.writeFile != nil {
		return ds.writeFile(path, data)
	}
	return atomicWrite(path, data)
}

func (ds *DecisionStore) withLifecycleLock(fn func() error) error {
	if ds.lifecycleLock == nil {
		return fn()
	}
	return ds.lifecycleLock.with(context.Background(), fn)
}

func (ds *DecisionStore) writeDecisionSet(decisions ...*models.DecisionEntry) error {
	type original struct {
		path string
		data []byte
	}
	originals := make([]original, 0, len(decisions))
	for _, decision := range decisions {
		if decision == nil || !models.ValidDecisionID(decision.ID) || !models.ValidDecisionStatus(decision.Status) || !models.ValidDecisionReviewState(decision.ReviewState) {
			return fmt.Errorf("invalid decision transition payload")
		}
		path := filepath.Join(ds.decisionsDir(), models.DecisionFileName(decision.ID))
		data, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("snapshot decision %q: %w", decision.ID, err)
		}
		originals = append(originals, original{path: path, data: data})
	}
	written := 0
	for i, decision := range decisions {
		if err := ds.write(originals[i].path, []byte(renderDecision(decision))); err != nil {
			var rollbackErr error
			for j := written - 1; j >= 0; j-- {
				if restoreErr := atomicWrite(originals[j].path, originals[j].data); restoreErr != nil && rollbackErr == nil {
					rollbackErr = restoreErr
				}
			}
			if rollbackErr != nil {
				return fmt.Errorf("write decision transition: %v (rollback failed: %v)", err, rollbackErr)
			}
			return fmt.Errorf("write decision transition: %w", err)
		}
		written++
	}
	return nil
}

func (ds *DecisionStore) parseFile(absPath string) (*models.DecisionEntry, error) {
	data, err := os.ReadFile(absPath)
	if err != nil {
		return nil, fmt.Errorf("parse decision %s: %w", absPath, err)
	}
	return parseDecisionContent(string(data))
}

func parseDecisionContent(content string) (*models.DecisionEntry, error) {
	yamlBlock, body := splitFrontmatter(content)
	if yamlBlock == "" {
		return nil, fmt.Errorf("missing decision frontmatter")
	}
	var fm decisionFrontmatter
	if err := yaml.Unmarshal([]byte(yamlBlock), &fm); err != nil {
		return nil, fmt.Errorf("parse decision frontmatter: %w", err)
	}
	decision := &models.DecisionEntry{
		ID:                       fm.ID,
		Title:                    fm.Title,
		Status:                   fm.Status,
		Supersedes:               normalizeStringSlice(fm.Supersedes),
		SupersededBy:             normalizeStringSlice(fm.SupersededBy),
		Tags:                     normalizeStringSlice(fm.Tags),
		Sources:                  normalizeStringSlice(fm.Sources),
		RelatedDocs:              normalizeStringSlice(fm.RelatedDocs),
		RelatedTasks:             normalizeStringSlice(fm.RelatedTasks),
		Verification:             normalizeStringSlice(fm.Verification),
		ReviewState:              fm.ReviewState,
		ReviewBlockers:           normalizeStringSlice(fm.ReviewBlockers),
		ReviewMatches:            fm.ReviewMatches,
		ReviewAllowedResolutions: normalizeStringSlice(fm.ReviewAllowedResolutions),
		Content:                  strings.TrimSpace(body),
	}
	if fm.VerifiedAt != "" {
		if parsed, err := parseISO(fm.VerifiedAt); err == nil {
			decision.VerifiedAt = &parsed
		}
	}
	decision.ReviewEvaluatedHash = fm.ReviewEvaluatedHash
	if fm.ReviewEvaluatedAt != "" {
		if parsed, err := parseISO(fm.ReviewEvaluatedAt); err == nil {
			decision.ReviewEvaluatedAt = &parsed
		}
	}
	decision.CreatedAt, _ = parseISO(fm.CreatedAt)
	decision.UpdatedAt, _ = parseISO(fm.UpdatedAt)
	applyDecisionSections(decision)
	return decision, nil
}

func applyDecisionSections(decision *models.DecisionEntry) {
	for _, section := range markdownSections(decision.Content) {
		switch strings.ToLower(section.title) {
		case "context":
			decision.Context = section.content
		case "decision":
			decision.Decision = section.content
		case "alternatives considered":
			decision.AlternativesConsidered = section.content
		case "consequences":
			decision.Consequences = section.content
		}
	}
}

type markdownSection struct {
	title   string
	content string
}

func markdownSections(body string) []markdownSection {
	lines := strings.Split(body, "\n")
	var sections []markdownSection
	var current *markdownSection
	var content []string
	flush := func() {
		if current == nil {
			return
		}
		current.content = strings.TrimSpace(strings.Join(content, "\n"))
		sections = append(sections, *current)
		content = nil
	}
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "## ") {
			flush()
			current = &markdownSection{title: strings.TrimSpace(strings.TrimPrefix(trimmed, "## "))}
			continue
		}
		if current != nil {
			content = append(content, line)
		}
	}
	flush()
	return sections
}

func renderDecision(decision *models.DecisionEntry) string {
	var b strings.Builder
	now := time.Now().UTC()
	createdAt := decision.CreatedAt
	if createdAt.IsZero() {
		createdAt = now
	}
	updatedAt := decision.UpdatedAt
	if updatedAt.IsZero() {
		updatedAt = now
	}

	b.WriteString("---\n")
	fmt.Fprintf(&b, "id: %s\n", yamlScalar(decision.ID))
	fmt.Fprintf(&b, "title: %s\n", yamlScalar(decision.Title))
	fmt.Fprintf(&b, "status: %s\n", yamlScalar(decision.Status))
	writeYAMLStringList(&b, "supersedes", decision.Supersedes)
	writeYAMLStringList(&b, "supersededBy", decision.SupersededBy)
	writeYAMLStringList(&b, "tags", decision.Tags)
	writeYAMLStringList(&b, "sources", decision.Sources)
	writeYAMLStringList(&b, "relatedDocs", decision.RelatedDocs)
	writeYAMLStringList(&b, "relatedTasks", decision.RelatedTasks)
	writeYAMLStringList(&b, "verification", decision.Verification)
	if decision.VerifiedAt != nil {
		fmt.Fprintf(&b, "verifiedAt: '%s'\n", formatISO(*decision.VerifiedAt))
	}
	if decision.ReviewState != "" ||
		len(decision.ReviewBlockers) > 0 ||
		len(decision.ReviewMatches) > 0 ||
		len(decision.ReviewAllowedResolutions) > 0 ||
		decision.ReviewEvaluatedHash != "" ||
		decision.ReviewEvaluatedAt != nil {
		fmt.Fprintf(&b, "reviewState: %s\n", yamlScalar(decision.ReviewState))
		writeYAMLStringList(&b, "reviewBlockers", decision.ReviewBlockers)
		writeDecisionReviewMatches(&b, decision.ReviewMatches)
		writeYAMLStringList(&b, "reviewAllowedResolutions", decision.ReviewAllowedResolutions)
		if decision.ReviewEvaluatedHash != "" {
			fmt.Fprintf(&b, "reviewEvaluatedHash: '%s'\n", decision.ReviewEvaluatedHash)
		}
		if decision.ReviewEvaluatedAt != nil {
			fmt.Fprintf(&b, "reviewEvaluatedAt: '%s'\n", formatISO(*decision.ReviewEvaluatedAt))
		}
	}
	fmt.Fprintf(&b, "createdAt: '%s'\n", formatISO(createdAt))
	fmt.Fprintf(&b, "updatedAt: '%s'\n", formatISO(updatedAt))
	b.WriteString("---\n\n")
	b.WriteString(renderDecisionBody(decision))
	if !strings.HasSuffix(b.String(), "\n") {
		b.WriteString("\n")
	}
	return b.String()
}

func writeDecisionReviewMatches(b *strings.Builder, matches []models.DecisionReviewMatch) {
	if len(matches) == 0 {
		fmt.Fprintln(b, "reviewMatches: []")
		return
	}
	fmt.Fprintln(b, "reviewMatches:")
	for _, match := range matches {
		fmt.Fprintf(b, "  - id: %s\n", yamlScalar(match.ID))
		fmt.Fprintf(b, "    title: %s\n", yamlScalar(match.Title))
		if match.Status != "" {
			fmt.Fprintf(b, "    status: %s\n", yamlScalar(match.Status))
		}
		fmt.Fprintf(b, "    score: %.6f\n", match.Score)
		if match.Kind != "" {
			fmt.Fprintf(b, "    kind: %s\n", yamlScalar(match.Kind))
		}
		if match.Hash != "" {
			fmt.Fprintf(b, "    hash: %s\n", yamlScalar(match.Hash))
		}
		writeIndentedYAMLStringList(b, "matchedBy", match.MatchedBy, 4)
		if match.Snippet != "" {
			fmt.Fprintf(b, "    snippet: %s\n", yamlScalar(match.Snippet))
		}
		writeIndentedYAMLStringList(b, "tags", match.Tags, 4)
	}
}

func writeIndentedYAMLStringList(b *strings.Builder, key string, values []string, spaces int) {
	if len(values) == 0 {
		return
	}
	indent := strings.Repeat(" ", spaces)
	fmt.Fprintf(b, "%s%s:\n", indent, key)
	for _, value := range values {
		fmt.Fprintf(b, "%s  - %s\n", indent, yamlScalar(value))
	}
}

func renderDecisionBody(decision *models.DecisionEntry) string {
	content := strings.TrimSpace(decision.Content)
	if content != "" {
		return content + "\n"
	}
	var b strings.Builder
	writeDecisionSection(&b, "Context", decision.Context)
	writeDecisionSection(&b, "Decision", decision.Decision)
	writeDecisionSection(&b, "Alternatives Considered", decision.AlternativesConsidered)
	writeDecisionSection(&b, "Consequences", decision.Consequences)
	return strings.TrimRight(b.String(), "\n") + "\n"
}

func writeDecisionSection(b *strings.Builder, title, content string) {
	if b.Len() > 0 {
		b.WriteString("\n")
	}
	fmt.Fprintf(b, "## %s\n\n", title)
	if strings.TrimSpace(content) != "" {
		b.WriteString(strings.TrimSpace(content))
		b.WriteString("\n")
	}
}

func writeYAMLStringList(b *strings.Builder, key string, values []string) {
	if len(values) == 0 {
		fmt.Fprintf(b, "%s: []\n", key)
		return
	}
	fmt.Fprintf(b, "%s:\n", key)
	for _, value := range values {
		fmt.Fprintf(b, "  - %s\n", yamlScalar(value))
	}
}

func appendUniqueStrings(existing []string, values ...string) []string {
	seen := make(map[string]bool, len(existing)+len(values))
	result := make([]string, 0, len(existing)+len(values))
	for _, value := range existing {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	return result
}

func decisionStringsContain(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
