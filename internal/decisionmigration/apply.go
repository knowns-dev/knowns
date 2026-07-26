package decisionmigration

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/howznguyen/knowns/internal/decisionreview"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

// Apply executes only explicitly selected candidates. Items are ordered so a
// duplicate target is established before followers are consolidated into it.
func (s *Service) Apply(ctx context.Context, selections []Selection) (*ApplyResult, error) {
	if err := s.ensureStore(); err != nil {
		return nil, err
	}
	if len(selections) == 0 {
		return nil, fmt.Errorf("at least one explicitly reviewed migration selection is required")
	}
	normalized := make([]Selection, len(selections))
	seen := make(map[string]bool)
	for i, selection := range selections {
		selection = canonicalSelection(selection)
		if err := selection.validate(); err != nil {
			return nil, err
		}
		if seen[selection.MemoryID] {
			return nil, fmt.Errorf("memory %q is selected more than once", selection.MemoryID)
		}
		seen[selection.MemoryID] = true
		normalized[i] = selection
	}
	sort.Slice(normalized, func(i, j int) bool {
		leftRank := applyRank(normalized[i].Resolution)
		rightRank := applyRank(normalized[j].Resolution)
		if leftRank != rightRank {
			return leftRank < rightRank
		}
		return normalized[i].MemoryID < normalized[j].MemoryID
	})

	result := &ApplyResult{Results: make([]ItemResult, 0, len(normalized))}
	failures := 0
	err := s.Store.WithDecisionMemoryMigrationLock(ctx, func() error {
		for _, selection := range normalized {
			item, itemErr := s.applyOne(selection)
			if itemErr != nil {
				failures++
				item = ItemResult{
					MemoryID:   selection.MemoryID,
					Resolution: selection.Resolution,
					State:      JournalFailed,
					Error:      itemErr.Error(),
				}
			}
			result.Results = append(result.Results, item)
		}
		return nil
	})
	if err != nil {
		return result, err
	}
	if failures > 0 {
		return result, fmt.Errorf("%d Decision Memory migration item(s) failed", failures)
	}
	return result, nil
}

func applyRank(resolution string) int {
	if resolution == ResolutionConsolidateDuplicate {
		return 2
	}
	return 1
}

func (s *Service) applyOne(selection Selection) (ItemResult, error) {
	existingJournal, err := s.readJournal(selection.MemoryID)
	if err != nil {
		return ItemResult{}, err
	}
	if existingJournal != nil {
		if !sameSelection(existingJournal.Selection, selection) {
			return ItemResult{}, fmt.Errorf("memory %q already has a migration journal for a different reviewed selection", selection.MemoryID)
		}
		switch existingJournal.State {
		case JournalApplied:
			return s.resumeApplied(existingJournal)
		case JournalRolledBack:
			return ItemResult{}, fmt.Errorf("migration for memory %q was rolled back; create a new reviewed migration selection", selection.MemoryID)
		case JournalPending, JournalFailed:
			if err := s.compensate(existingJournal); err != nil {
				return ItemResult{}, fmt.Errorf("recover prior %s migration for memory %q: %w", existingJournal.State, selection.MemoryID, err)
			}
		}
	}

	memory, err := s.Store.Memory.Get(selection.MemoryID)
	if err != nil {
		return ItemResult{}, err
	}
	if !models.IsLegacyDecisionMemoryCategory(memory.Category) {
		return ItemResult{}, fmt.Errorf("memory %q is no longer a legacy Decision Memory", selection.MemoryID)
	}
	journal, err := s.prepareJournal(selection, memory)
	if err != nil {
		return ItemResult{}, err
	}
	if err := s.writeJournal(journal); err != nil {
		return ItemResult{}, err
	}

	if err := s.executeJournal(journal, memory); err != nil {
		return ItemResult{}, s.failAndCompensate(journal, err)
	}
	journal.State = JournalApplied
	journal.Error = ""
	journal.UpdatedAt = s.now()
	if err := s.step(selection.MemoryID, "before_commit"); err != nil {
		return ItemResult{}, s.failAndCompensate(journal, err)
	}
	if err := s.writeJournal(journal); err != nil {
		return ItemResult{}, s.failAndCompensate(journal, err)
	}
	return itemFromJournal(journal, false), nil
}

func (s *Service) prepareJournal(selection Selection, memory *models.MemoryEntry) (*Journal, error) {
	now := s.now()
	journal := &Journal{
		Version:        journalVersion,
		MigrationID:    s.migrationID(memory.ID),
		MemoryID:       memory.ID,
		Selection:      selection,
		OriginalMemory: cloneMemory(memory),
		State:          JournalPending,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	memoryRef := memoryReference(memory.ID)

	switch selection.Resolution {
	case ResolutionCreateDecision:
		id := selection.DecisionID
		if id != "" {
			if !models.ValidDecisionID(id) {
				return nil, fmt.Errorf("invalid decision ID %q", id)
			}
			if _, err := s.Store.Decisions.Get(id); err == nil {
				return nil, fmt.Errorf("decision %q already exists", id)
			}
		} else {
			id = models.NewDecisionID(memory.Title, memory.CreatedAt, func(candidate string) bool {
				_, getErr := s.Store.Decisions.Get(candidate)
				return getErr == nil
			})
		}
		journal.DecisionID = id
		journal.DecisionCreated = true
		journal.AddedSources = append([]string{memoryRef}, migrationDecisionSources(memory, id)...)
		journal.AddedSources = sortedUnique(journal.AddedSources)
		journal.AddedDocs = append([]string(nil), selection.RelatedDocs...)
		journal.AddedTasks = append([]string(nil), selection.RelatedTasks...)
	case ResolutionLinkExisting:
		decision, err := s.Store.Decisions.Get(selection.DecisionID)
		if err != nil {
			return nil, err
		}
		requestedSources := append([]string{memoryRef}, migrationDecisionSources(memory, decision.ID)...)
		journal.DecisionID = decision.ID
		journal.AddedSources = addedValues(decision.Sources, requestedSources)
		journal.AddedDocs = addedValues(decision.RelatedDocs, selection.RelatedDocs)
		journal.AddedTasks = addedValues(decision.RelatedTasks, selection.RelatedTasks)
	case ResolutionConsolidateDuplicate:
		decisionID, err := s.resolveDuplicateDecision(selection.TargetMemoryID)
		if err != nil {
			return nil, err
		}
		decision, err := s.Store.Decisions.Get(decisionID)
		if err != nil {
			return nil, err
		}
		journal.DecisionID = decision.ID
		journal.AddedSources = addedValues(decision.Sources, []string{memoryRef})
	case ResolutionReclassify, ResolutionArchiveNoise, ResolutionRejectNoise, ResolutionLeaveUnchanged:
	default:
		return nil, fmt.Errorf("unsupported migration resolution %q", selection.Resolution)
	}
	return journal, nil
}

func (s *Service) resolveDuplicateDecision(targetMemoryID string) (string, error) {
	if !validMigrationMemoryID(targetMemoryID) {
		return "", fmt.Errorf("invalid duplicate target memory ID %q", targetMemoryID)
	}
	targetJournal, err := s.readJournal(targetMemoryID)
	if err != nil {
		return "", err
	}
	if targetJournal != nil && targetJournal.State == JournalApplied && targetJournal.DecisionID != "" {
		return targetJournal.DecisionID, nil
	}
	target, err := s.Store.Memory.Get(targetMemoryID)
	if err != nil {
		return "", err
	}
	if target.Metadata != nil && target.Metadata[models.LegacyDecisionMigrationDecisionKey] != "" {
		return target.Metadata[models.LegacyDecisionMigrationDecisionKey], nil
	}
	return "", fmt.Errorf("duplicate target memory %q has no applied Decision migration", targetMemoryID)
}

func (s *Service) executeJournal(journal *Journal, memory *models.MemoryEntry) error {
	if err := s.step(memory.ID, "before_decision"); err != nil {
		return err
	}
	switch journal.Selection.Resolution {
	case ResolutionCreateDecision:
		decision := migrationDecision(memory, journal)
		if err := s.Store.Decisions.Create(decision, storage.DecisionCreateOptions{Now: journal.CreatedAt}); err != nil {
			return err
		}
	case ResolutionLinkExisting, ResolutionConsolidateDuplicate:
		if _, err := s.Store.Decisions.Link(journal.DecisionID, journal.AddedDocs, journal.AddedTasks, journal.AddedSources); err != nil {
			return err
		}
	}

	if journal.Selection.AcceptVerified && journal.DecisionID != "" {
		decision, err := s.Store.Decisions.Get(journal.DecisionID)
		if err != nil {
			return err
		}
		if !decision.CurrentForDefaultRetrieval() {
			if _, err := decisionreview.New(s.Store).Accept(journal.DecisionID, decisionreview.AcceptOptions{}); err != nil {
				return fmt.Errorf("verify migrated decision %q: %w", journal.DecisionID, err)
			}
		}
	}

	if err := s.step(memory.ID, "before_memory"); err != nil {
		return err
	}
	switch journal.Selection.Resolution {
	case ResolutionReclassify, ResolutionArchiveNoise, ResolutionRejectNoise:
		return s.applyMemoryResolution(journal, memory)
	case ResolutionCreateDecision, ResolutionLinkExisting, ResolutionConsolidateDuplicate:
		return s.finalizeLegacyExclusion(journal, memory)
	case ResolutionLeaveUnchanged:
		return nil
	default:
		return fmt.Errorf("unsupported migration resolution %q", journal.Selection.Resolution)
	}
}

func (s *Service) applyMemoryResolution(journal *Journal, memory *models.MemoryEntry) error {
	updated := cloneMemory(memory)
	switch journal.Selection.Resolution {
	case ResolutionReclassify:
		updated.Category = journal.Selection.Category
	case ResolutionArchiveNoise:
		updated.Status = models.MemoryStatusArchived
	case ResolutionRejectNoise:
		updated.Status = models.MemoryStatusRejected
		updated.RejectedReason = firstNonEmpty(journal.Selection.Reason, "Reviewed as legacy Decision Memory noise")
	}
	markMigratedMemory(updated, journal)
	if err := s.Store.Memory.Update(updated); err != nil {
		return err
	}
	journal.LegacyExcluded = true
	return nil
}

func (s *Service) finalizeLegacyExclusion(journal *Journal, memory *models.MemoryEntry) error {
	if !s.CurrentDecisionConsumptionActive || journal.DecisionID == "" {
		return nil
	}
	decision, err := s.Store.Decisions.Get(journal.DecisionID)
	if err != nil {
		return err
	}
	if !decision.CurrentForDefaultRetrieval() {
		return nil
	}
	current, err := s.Store.Memory.Get(memory.ID)
	if err != nil {
		return err
	}
	if current.Metadata != nil && current.Metadata[models.LegacyDecisionMigrationIDKey] == journal.MigrationID && !current.CurrentForDefaultRetrieval() {
		journal.LegacyExcluded = true
		return nil
	}
	if !models.IsLegacyDecisionMemoryCategory(current.Category) {
		return fmt.Errorf("memory %q changed category outside migration", memory.ID)
	}
	updated := cloneMemory(current)
	if updated.Status != models.MemoryStatusRejected {
		updated.Status = models.MemoryStatusArchived
	}
	updated.MergedInto = models.DecisionRef(journal.DecisionID)
	markMigratedMemory(updated, journal)
	if err := s.Store.Memory.Update(updated); err != nil {
		return err
	}
	journal.LegacyExcluded = true
	return nil
}

func (s *Service) resumeApplied(journal *Journal) (ItemResult, error) {
	if journal.DecisionID == "" || journal.LegacyExcluded {
		return itemFromJournal(journal, true), nil
	}
	memory, err := s.Store.Memory.Get(journal.MemoryID)
	if err != nil {
		return ItemResult{}, err
	}
	wasExcluded := journal.LegacyExcluded
	if err := s.finalizeLegacyExclusion(journal, memory); err != nil {
		return ItemResult{}, err
	}
	if journal.LegacyExcluded != wasExcluded {
		journal.UpdatedAt = s.now()
		if err := s.writeJournal(journal); err != nil {
			if restoreErr := s.Store.Memory.RestoreLegacyDecisionMigration(journal.OriginalMemory, expectedMigratedMemory(journal), journal.MigrationID); restoreErr != nil {
				return ItemResult{}, fmt.Errorf("update finalized migration journal: %v (memory rollback failed: %v)", err, restoreErr)
			}
			journal.LegacyExcluded = false
			return ItemResult{}, err
		}
	}
	return itemFromJournal(journal, true), nil
}

func (s *Service) failAndCompensate(journal *Journal, cause error) error {
	compensationErr := s.compensate(journal)
	journal.State = JournalFailed
	journal.Error = cause.Error()
	journal.LegacyExcluded = false
	journal.UpdatedAt = s.now()
	journalErr := s.writeJournal(journal)
	if compensationErr != nil || journalErr != nil {
		return fmt.Errorf("migration failed: %v (compensation: %v; journal: %v)", cause, compensationErr, journalErr)
	}
	return cause
}

func (s *Service) compensate(journal *Journal) error {
	var firstErr error
	if journal.OriginalMemory != nil {
		current, err := s.Store.Memory.Get(journal.MemoryID)
		if err == nil && current.Metadata != nil && current.Metadata[models.LegacyDecisionMigrationIDKey] == journal.MigrationID {
			if err := s.Store.Memory.RestoreLegacyDecisionMigration(cloneMemory(journal.OriginalMemory), expectedMigratedMemory(journal), journal.MigrationID); err != nil {
				firstErr = err
			}
		}
	}
	if journal.DecisionID != "" {
		_, getErr := s.Store.Decisions.Get(journal.DecisionID)
		if getErr != nil && journal.DecisionCreated {
			return firstErr
		}
		err := s.Store.Decisions.RollbackLegacyMemoryMigration(
			journal.DecisionID,
			memoryReference(journal.MemoryID),
			journal.DecisionCreated,
			journal.AddedSources,
			journal.AddedDocs,
			journal.AddedTasks,
		)
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func migrationDecision(memory *models.MemoryEntry, journal *Journal) *models.DecisionEntry {
	return &models.DecisionEntry{
		ID:           journal.DecisionID,
		Title:        memory.Title,
		Status:       models.DecisionStatusDraft,
		Tags:         []string{"legacy-memory-migration"},
		Sources:      append([]string(nil), journal.AddedSources...),
		RelatedDocs:  append([]string(nil), journal.AddedDocs...),
		RelatedTasks: append([]string(nil), journal.AddedTasks...),
		CreatedAt:    memory.CreatedAt,
		Context: fmt.Sprintf(
			"Migrated through reviewed provenance from legacy Decision Memory %s (layer %s, prior status %s).",
			memoryReference(memory.ID), memory.Layer, memory.Status,
		),
		Decision:               strings.TrimSpace(memory.Content),
		AlternativesConsidered: "The legacy Memory record did not encode alternatives in the System Decision lifecycle.",
		Consequences:           "This Decision remains draft until linked evidence is verified. The legacy record stays in default retrieval until this Decision becomes current accepted guidance.",
	}
}

func migrationDecisionSources(memory *models.MemoryEntry, decisionID string) []string {
	selfRef := models.DecisionRef(decisionID)
	result := make([]string, 0)
	for _, source := range memorySources(memory) {
		if source != selfRef {
			result = append(result, source)
		}
	}
	return sortedUnique(result)
}

func markMigratedMemory(memory *models.MemoryEntry, journal *Journal) {
	if memory.Metadata == nil {
		memory.Metadata = make(map[string]string)
	}
	memory.Metadata[models.LegacyDecisionMigrationIDKey] = journal.MigrationID
	memory.Metadata[models.LegacyDecisionMigrationResolutionKey] = journal.Selection.Resolution
	if journal.DecisionID != "" {
		memory.Metadata[models.LegacyDecisionMigrationDecisionKey] = journal.DecisionID
	}
}

func expectedMigratedMemory(journal *Journal) *models.MemoryEntry {
	if journal == nil || journal.OriginalMemory == nil {
		return nil
	}
	expected := cloneMemory(journal.OriginalMemory)
	switch journal.Selection.Resolution {
	case ResolutionReclassify:
		expected.Category = journal.Selection.Category
	case ResolutionArchiveNoise:
		expected.Status = models.MemoryStatusArchived
	case ResolutionRejectNoise:
		expected.Status = models.MemoryStatusRejected
		expected.RejectedReason = firstNonEmpty(journal.Selection.Reason, "Reviewed as legacy Decision Memory noise")
	case ResolutionCreateDecision, ResolutionLinkExisting, ResolutionConsolidateDuplicate:
		if expected.Status != models.MemoryStatusRejected {
			expected.Status = models.MemoryStatusArchived
		}
		expected.MergedInto = models.DecisionRef(journal.DecisionID)
	default:
		return nil
	}
	markMigratedMemory(expected, journal)
	return expected
}

func memoryReference(id string) string {
	return "@memory/" + id
}

func cloneMemory(entry *models.MemoryEntry) *models.MemoryEntry {
	if entry == nil {
		return nil
	}
	copy := *entry
	copy.Sources = append([]string(nil), entry.Sources...)
	copy.Tags = append([]string(nil), entry.Tags...)
	copy.LifecycleMetadataMissing = append([]string(nil), entry.LifecycleMetadataMissing...)
	if entry.Metadata != nil {
		copy.Metadata = make(map[string]string, len(entry.Metadata))
		for key, value := range entry.Metadata {
			copy.Metadata[key] = value
		}
	}
	return &copy
}

func itemFromJournal(journal *Journal, idempotent bool) ItemResult {
	return ItemResult{
		MemoryID:       journal.MemoryID,
		Resolution:     journal.Selection.Resolution,
		State:          journal.State,
		DecisionID:     journal.DecisionID,
		LegacyExcluded: journal.LegacyExcluded,
		Idempotent:     idempotent,
		Error:          journal.Error,
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}
