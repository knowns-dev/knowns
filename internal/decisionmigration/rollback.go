package decisionmigration

import (
	"context"
	"fmt"
)

// Rollback reverses one reviewed migration from its durable journal. It is
// idempotent; unsafe post-migration supersession relationships stop rollback.
func (s *Service) Rollback(ctx context.Context, memoryID string) (*RollbackResult, error) {
	if err := s.ensureStore(); err != nil {
		return nil, err
	}
	if !validMigrationMemoryID(memoryID) {
		return nil, fmt.Errorf("invalid migration memory ID %q", memoryID)
	}
	var result *RollbackResult
	err := s.Store.WithDecisionMemoryMigrationLock(ctx, func() error {
		journal, err := s.readJournal(memoryID)
		if err != nil {
			return err
		}
		if journal == nil {
			return fmt.Errorf("migration journal for memory %q not found", memoryID)
		}
		if journal.State == JournalRolledBack {
			result = &RollbackResult{MemoryID: memoryID, State: JournalRolledBack, DecisionID: journal.DecisionID}
			return nil
		}
		if err := s.compensate(journal); err != nil {
			return err
		}
		journal.State = JournalRolledBack
		journal.LegacyExcluded = false
		journal.Error = ""
		journal.UpdatedAt = s.now()
		if err := s.writeJournal(journal); err != nil {
			return err
		}
		result = &RollbackResult{MemoryID: memoryID, State: JournalRolledBack, DecisionID: journal.DecisionID}
		return nil
	})
	return result, err
}
