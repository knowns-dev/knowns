package storage

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

// TaskLifecycleTransaction exposes storage primitives that are safe to compose
// while the project lifecycle lock is held.
type TaskLifecycleTransaction struct {
	store *Store
}

func (tx *TaskLifecycleTransaction) GetTask(id string) (*models.Task, error) {
	return tx.store.Tasks.Get(id)
}

func (tx *TaskLifecycleTransaction) ListActiveTasks() ([]*models.Task, error) {
	return tx.store.Tasks.List()
}

func (tx *TaskLifecycleTransaction) ListArchivedTasks() ([]*models.Task, error) {
	return tx.store.Tasks.ListArchived()
}

func (tx *TaskLifecycleTransaction) HasActiveTimer(id string) (bool, error) {
	timer, err := tx.store.Time.GetActiveTimerWithError(id)
	return timer != nil, err
}

func (tx *TaskLifecycleTransaction) GetTimeState() (*models.TimeState, error) {
	return tx.store.Time.GetState()
}

func (tx *TaskLifecycleTransaction) SaveTimeState(state *models.TimeState) error {
	return tx.store.Time.saveStateUnlocked(state)
}

func (tx *TaskLifecycleTransaction) GetAllTimeEntries() (map[string][]models.TimeEntry, error) {
	return tx.store.Time.GetAllEntries()
}

func (tx *TaskLifecycleTransaction) SaveAllTimeEntries(entries map[string][]models.TimeEntry) error {
	return tx.store.Time.saveAllEntriesUnlocked(entries)
}

// PatchTaskLifecycle updates only status/timing frontmatter so lifecycle
// transitions do not re-render or discard unknown Task content.
func (tx *TaskLifecycleTransaction) PatchTaskLifecycle(task *models.Task) error {
	return tx.store.Tasks.patchLifecycleUnlocked(task)
}

// UpdateTask writes a complete Task while the lifecycle transaction is held.
// Callers must first read the canonical Task through this transaction.
func (tx *TaskLifecycleTransaction) UpdateTask(task *models.Task) error {
	return tx.store.Tasks.updateUnlocked(task)
}

func (tx *TaskLifecycleTransaction) TrackTaskChanges(before, after *models.Task) []models.TaskChange {
	return tx.store.Versions.TrackChanges(before, after)
}

func (tx *TaskLifecycleTransaction) ArchiveTask(id string) error {
	return tx.store.Tasks.archiveUnlocked(id)
}

func (tx *TaskLifecycleTransaction) UnarchiveTask(id string) error {
	return tx.store.Tasks.unarchiveUnlocked(id)
}

func (tx *TaskLifecycleTransaction) DeleteTask(id string) error {
	_, err := tx.store.Tasks.deleteAllUnlocked(id)
	return err
}

func (tx *TaskLifecycleTransaction) SaveTombstone(tombstone *models.TaskTombstone) error {
	return tx.store.Tasks.saveTombstoneUnlocked(tombstone)
}

func (tx *TaskLifecycleTransaction) GetTombstone(id string) (*models.TaskTombstone, error) {
	return tx.store.Tasks.GetTombstone(id)
}

func (tx *TaskLifecycleTransaction) IsIDReserved(id string) (bool, error) {
	return tx.store.Tasks.IsIDReserved(id)
}

func (tx *TaskLifecycleTransaction) GetTaskLifecyclePending(taskID, operation string) (*models.TaskLifecyclePending, error) {
	records, err := tx.ListTaskLifecyclePending(operation)
	if err != nil {
		return nil, err
	}
	var latest *models.TaskLifecyclePending
	for _, pending := range records {
		if pending.TaskID != taskID {
			continue
		}
		if !pending.CanonicalComplete {
			return pending, nil
		}
		latest = pending
	}
	return latest, nil
}

func (tx *TaskLifecycleTransaction) GetIncompleteTaskLifecyclePending(taskID, operation string) (*models.TaskLifecyclePending, error) {
	records, err := tx.ListTaskLifecyclePending(operation)
	if err != nil {
		return nil, err
	}
	for _, pending := range records {
		canonicalComplete := pending.CanonicalComplete
		if operation == "archive" || operation == "reopen" {
			canonicalComplete = canonicalComplete && pending.MoveComplete && pending.PatchComplete && pending.VersionComplete
		}
		if pending.TaskID == taskID && !canonicalComplete {
			return pending, nil
		}
	}
	return nil, nil
}

func (tx *TaskLifecycleTransaction) GetTaskLifecyclePendingEvent(taskID, operation, eventID string) (*models.TaskLifecyclePending, error) {
	path, err := tx.taskLifecyclePendingPath(taskID, operation, eventID)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read pending Task lifecycle %q/%q/%q: %w", taskID, operation, eventID, err)
	}
	var pending models.TaskLifecyclePending
	if err := json.Unmarshal(data, &pending); err != nil {
		return nil, fmt.Errorf("parse pending Task lifecycle %q/%q/%q: %w", taskID, operation, eventID, err)
	}
	if pending.TaskID != taskID || pending.Operation != operation || pending.EventID != eventID {
		return nil, fmt.Errorf("pending Task lifecycle identity mismatch for %q/%q/%q", taskID, operation, eventID)
	}
	return &pending, nil
}

func (tx *TaskLifecycleTransaction) ListTaskLifecyclePending(operation string) ([]*models.TaskLifecyclePending, error) {
	dir := tx.taskLifecyclePendingDir()
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return []*models.TaskLifecyclePending{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("list pending Task lifecycle: %w", err)
	}
	result := make([]*models.TaskLifecyclePending, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			return nil, fmt.Errorf("read pending Task lifecycle %q: %w", entry.Name(), err)
		}
		var pending models.TaskLifecyclePending
		if err := json.Unmarshal(data, &pending); err != nil {
			return nil, fmt.Errorf("parse pending Task lifecycle %q: %w", entry.Name(), err)
		}
		if operation == "" || pending.Operation == operation {
			copy := pending
			result = append(result, &copy)
		}
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].At.Equal(result[j].At) {
			if result[i].TaskID == result[j].TaskID {
				if result[i].Operation == result[j].Operation {
					return result[i].EventID < result[j].EventID
				}
				return result[i].Operation < result[j].Operation
			}
			return result[i].TaskID < result[j].TaskID
		}
		return result[i].At.Before(result[j].At)
	})
	return result, nil
}

func (tx *TaskLifecycleTransaction) SaveTaskLifecyclePending(pending *models.TaskLifecyclePending) error {
	if pending == nil || pending.EventID == "" || pending.At.IsZero() {
		return fmt.Errorf("pending Task lifecycle requires eventId and timestamp")
	}
	path, err := tx.taskLifecyclePendingPath(pending.TaskID, pending.Operation, pending.EventID)
	if err != nil {
		return err
	}
	return writeJSON(path, pending)
}

func (tx *TaskLifecycleTransaction) DeleteTaskLifecyclePending(taskID, operation, eventID string) error {
	path, err := tx.taskLifecyclePendingPath(taskID, operation, eventID)
	if err != nil {
		return err
	}
	err = os.Remove(path)
	if err == nil || os.IsNotExist(err) {
		return nil
	}
	return fmt.Errorf("delete pending Task lifecycle %q/%q: %w", taskID, operation, err)
}

func (tx *TaskLifecycleTransaction) taskLifecyclePendingDir() string {
	return filepath.Join(tx.store.Root, ".search", "task-lifecycle", "pending")
}

func (tx *TaskLifecycleTransaction) taskLifecyclePendingPath(taskID, operation, eventID string) (string, error) {
	if _, err := tx.store.Tasks.tombstonePath(taskID); err != nil {
		return "", err
	}
	switch operation {
	case "archive", "reopen", "hard_delete":
	default:
		return "", fmt.Errorf("invalid Task lifecycle operation %q", operation)
	}
	if strings.TrimSpace(eventID) == "" {
		return "", fmt.Errorf("pending Task lifecycle event ID is required")
	}
	digest := sha256.Sum256([]byte(eventID))
	return filepath.Join(tx.taskLifecyclePendingDir(), fmt.Sprintf("%x.json", digest)), nil
}

func (tx *TaskLifecycleTransaction) SaveTaskVersion(oldTask, newTask *models.Task, actor string, timestamp time.Time, lifecycleEventID string) error {
	if newTask == nil {
		return fmt.Errorf("save lifecycle version: task is required")
	}
	changes := tx.store.Versions.TrackChanges(oldTask, newTask)
	if len(changes) == 0 {
		return nil
	}
	return tx.store.Versions.saveVersionUnlocked(newTask.ID, models.TaskVersion{
		Timestamp:        timestamp,
		Author:           actor,
		LifecycleEventID: lifecycleEventID,
		Changes:          changes,
		Snapshot:         TaskToSnapshot(newTask),
	})
}

func (tx *TaskLifecycleTransaction) HasTaskLifecycleVersion(taskID, eventID string) (bool, error) {
	if eventID == "" {
		return false, nil
	}
	history, err := tx.store.Versions.GetHistory(taskID)
	if err != nil {
		return false, err
	}
	for _, version := range history.Versions {
		if version.LifecycleEventID == eventID {
			return true, nil
		}
	}
	return false, nil
}

func (tx *TaskLifecycleTransaction) RollbackTaskLifecycleVersion(taskID, eventID string) error {
	if eventID == "" {
		return nil
	}
	history, err := tx.store.Versions.GetHistory(taskID)
	if err != nil {
		return err
	}
	if len(history.Versions) == 0 || history.Versions[len(history.Versions)-1].LifecycleEventID != eventID {
		return nil
	}
	history.Versions = history.Versions[:len(history.Versions)-1]
	history.CurrentVersion--
	if len(history.Versions) == 0 {
		err := os.Remove(tx.store.Versions.versionPath(taskID))
		if err == nil || os.IsNotExist(err) {
			return nil
		}
		return err
	}
	return writeJSON(tx.store.Versions.versionPath(taskID), history)
}

func (tx *TaskLifecycleTransaction) DeleteTaskVersionHistory(id string) error {
	err := os.Remove(tx.store.Versions.versionPath(id))
	if err == nil || os.IsNotExist(err) {
		return nil
	}
	return fmt.Errorf("delete task version history %q: %w", id, err)
}

// DeleteTaskTimeData removes both active and completed time data. It is
// idempotent so a tombstone-first hard-delete can safely resume after failure.
func (tx *TaskLifecycleTransaction) DeleteTaskTimeData(id string) error {
	state, err := tx.store.Time.GetState()
	if err != nil {
		return err
	}
	active := state.Active[:0]
	for _, timer := range state.Active {
		if timer.TaskID != id {
			active = append(active, timer)
		}
	}
	state.Active = active
	if err := tx.store.Time.saveStateUnlocked(state); err != nil {
		return fmt.Errorf("delete task timer %q: %w", id, err)
	}

	entries, err := tx.store.Time.GetAllEntries()
	if err != nil {
		return err
	}
	if _, ok := entries[id]; ok {
		delete(entries, id)
		if err := writeJSON(tx.store.Time.entriesPath(), entries); err != nil {
			return fmt.Errorf("delete task time entries %q: %w", id, err)
		}
	}
	return nil
}
