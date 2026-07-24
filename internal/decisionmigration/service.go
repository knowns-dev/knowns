package decisionmigration

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/storage"
)

const journalVersion = 1

type Service struct {
	Store                            *storage.Store
	Now                              func() time.Time
	CurrentDecisionConsumptionActive bool

	beforeStep    func(memoryID, step string) error
	journalWriter func(*Journal) error
}

func New(store *storage.Store) *Service {
	return &Service{
		Store:                            store,
		CurrentDecisionConsumptionActive: true,
	}
}

func (s *Service) ensureStore() error {
	if s == nil || s.Store == nil || s.Store.Memory == nil || s.Store.Decisions == nil {
		return fmt.Errorf("Decision Memory migration store unavailable")
	}
	return nil
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

func (s *Service) migrationID(memoryID string) string {
	return "decision-memory-" + memoryID
}

func (s *Service) journalDir() string {
	return filepath.Join(s.Store.Root, "migrations", "decision-memory")
}

func (s *Service) journalPath(memoryID string) (string, error) {
	if !validMigrationMemoryID(memoryID) {
		return "", fmt.Errorf("invalid migration memory ID %q", memoryID)
	}
	return filepath.Join(s.journalDir(), memoryID+".json"), nil
}

func (s *Service) readJournal(memoryID string) (*Journal, error) {
	path, err := s.journalPath(memoryID)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read migration journal for memory %q: %w", memoryID, err)
	}
	var journal Journal
	if err := json.Unmarshal(data, &journal); err != nil {
		return nil, fmt.Errorf("parse migration journal for memory %q: %w", memoryID, err)
	}
	if journal.Version != journalVersion || journal.MemoryID != memoryID || journal.MigrationID != s.migrationID(memoryID) {
		return nil, fmt.Errorf("migration journal for memory %q has an unsupported identity or version", memoryID)
	}
	return &journal, nil
}

func (s *Service) writeJournal(journal *Journal) error {
	if s.journalWriter != nil {
		return s.journalWriter(journal)
	}
	path, err := s.journalPath(journal.MemoryID)
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(journal, "", "  ")
	if err != nil {
		return fmt.Errorf("encode migration journal for memory %q: %w", journal.MemoryID, err)
	}
	data = append(data, '\n')
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create migration journal directory: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".decision-memory-*.tmp")
	if err != nil {
		return fmt.Errorf("create migration journal temp file: %w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("write migration journal temp file: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("sync migration journal temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close migration journal temp file: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return fmt.Errorf("commit migration journal for memory %q: %w", journal.MemoryID, err)
	}
	return nil
}

func (s *Service) step(memoryID, step string) error {
	if s.beforeStep == nil {
		return nil
	}
	return s.beforeStep(memoryID, step)
}

func canonicalSelection(selection Selection) Selection {
	selection.MemoryID = strings.TrimSpace(selection.MemoryID)
	selection.Resolution = strings.TrimSpace(selection.Resolution)
	selection.DecisionID = strings.TrimSpace(selection.DecisionID)
	selection.TargetMemoryID = strings.TrimSpace(selection.TargetMemoryID)
	selection.Category = strings.ToLower(strings.TrimSpace(selection.Category))
	selection.Reason = strings.TrimSpace(selection.Reason)
	selection.RelatedDocs = sortedUnique(selection.RelatedDocs)
	selection.RelatedTasks = sortedUnique(selection.RelatedTasks)
	return selection
}

func sameSelection(left, right Selection) bool {
	left = canonicalSelection(left)
	right = canonicalSelection(right)
	return left.MemoryID == right.MemoryID &&
		left.Resolution == right.Resolution &&
		left.DecisionID == right.DecisionID &&
		left.TargetMemoryID == right.TargetMemoryID &&
		left.Category == right.Category &&
		left.Reason == right.Reason &&
		left.AcceptVerified == right.AcceptVerified &&
		strings.Join(left.RelatedDocs, "\x00") == strings.Join(right.RelatedDocs, "\x00") &&
		strings.Join(left.RelatedTasks, "\x00") == strings.Join(right.RelatedTasks, "\x00")
}

func sortedUnique(values []string) []string {
	seen := make(map[string]bool)
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			seen[value] = true
		}
	}
	result := make([]string, 0, len(seen))
	for value := range seen {
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

func addedValues(existing, requested []string) []string {
	seen := make(map[string]bool, len(existing))
	for _, value := range existing {
		seen[strings.TrimSpace(value)] = true
	}
	result := make([]string, 0)
	for _, value := range sortedUnique(requested) {
		if !seen[value] {
			result = append(result, value)
		}
	}
	return result
}
