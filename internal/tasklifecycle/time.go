package tasklifecycle

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

// StopTimer atomically removes an active timer, appends its completed entry,
// increments canonical Task.TimeSpent, and records the Task version while the
// lifecycle lock is held. Index reconciliation runs after the lock is released.
func (service *Service) StopTimer(ctx context.Context, taskID, actor string) (*models.TimeEntry, error) {
	var recorded *models.TimeEntry
	err := service.store.WithTaskLifecycleTransaction(ctx, func(tx *storage.TaskLifecycleTransaction) error {
		task, err := activeTaskForTimeMutation(tx, taskID)
		if err != nil {
			return err
		}
		state, err := tx.GetTimeState()
		if err != nil {
			return err
		}
		entries, err := tx.GetAllTimeEntries()
		if err != nil {
			return err
		}

		beforeState := cloneTimeState(state)
		beforeEntries := cloneTimeEntries(entries)
		beforeTask := cloneTask(task)
		now := service.now().UTC()
		entry, nextState, err := completedEntryForTimer(state, taskID, now)
		if err != nil {
			return err
		}
		nextEntries := cloneTimeEntries(entries)
		nextEntries[taskID] = append(nextEntries[taskID], entry)
		nextTask := cloneTask(task)
		nextTask.TimeSpent = totalTimeSpent(nextEntries[taskID])
		nextTask.UpdatedAt = now

		if err := tx.SaveAllTimeEntries(nextEntries); err != nil {
			return err
		}
		if err := tx.SaveTimeState(nextState); err != nil {
			return rollbackTimeMutation(tx, beforeTask, beforeState, beforeEntries, err)
		}
		if err := tx.UpdateTask(nextTask); err != nil {
			return rollbackTimeMutation(tx, beforeTask, beforeState, beforeEntries, err)
		}
		if err := tx.SaveTaskVersion(beforeTask, nextTask, actor, now, ""); err != nil {
			return rollbackTimeMutation(tx, beforeTask, beforeState, beforeEntries, err)
		}
		copy := entry
		recorded = &copy
		return nil
	})
	if err != nil {
		return nil, err
	}
	if err := service.indexTask(taskID); err != nil {
		return recorded, err
	}
	return recorded, nil
}

// AddTimeEntry atomically appends a manual entry and updates Task.TimeSpent.
// Archived and hard-deleted Tasks are rejected before any time data changes.
func (service *Service) AddTimeEntry(ctx context.Context, taskID string, options TimeMutationOptions) (*models.TimeEntry, error) {
	entry := options.Entry
	if entry.Duration < 0 {
		return nil, fmt.Errorf("time entry duration must be non-negative")
	}
	if entry.StartedAt.IsZero() {
		entry.StartedAt = service.now().UTC()
	} else {
		entry.StartedAt = entry.StartedAt.UTC()
	}
	if entry.EndedAt == nil {
		endedAt := entry.StartedAt.Add(time.Duration(entry.Duration) * time.Second)
		entry.EndedAt = &endedAt
	} else {
		endedAt := entry.EndedAt.UTC()
		entry.EndedAt = &endedAt
	}
	if strings.TrimSpace(entry.ID) == "" {
		entry.ID = fmt.Sprintf("te-%d-%s", service.now().UTC().UnixNano(), taskID)
	}

	err := service.store.WithTaskLifecycleTransaction(ctx, func(tx *storage.TaskLifecycleTransaction) error {
		task, err := activeTaskForTimeMutation(tx, taskID)
		if err != nil {
			return err
		}
		entries, err := tx.GetAllTimeEntries()
		if err != nil {
			return err
		}
		beforeEntries := cloneTimeEntries(entries)
		beforeTask := cloneTask(task)
		alreadyRecorded := false
		for _, existing := range entries[taskID] {
			if existing.ID == entry.ID {
				if existing.Duration == entry.Duration && existing.StartedAt.Equal(entry.StartedAt) {
					entry = existing
					alreadyRecorded = true
					break
				}
				return fmt.Errorf("time entry %q already exists with different content", entry.ID)
			}
		}
		nextEntries := cloneTimeEntries(entries)
		if !alreadyRecorded {
			nextEntries[taskID] = append(nextEntries[taskID], entry)
		}
		now := service.now().UTC()
		nextTask := cloneTask(task)
		nextTask.TimeSpent = totalTimeSpent(nextEntries[taskID])
		nextTask.UpdatedAt = now
		if alreadyRecorded && nextTask.TimeSpent == task.TimeSpent {
			return nil
		}

		if err := tx.SaveAllTimeEntries(nextEntries); err != nil {
			return err
		}
		if err := tx.UpdateTask(nextTask); err != nil {
			return rollbackTimeMutation(tx, beforeTask, nil, beforeEntries, err)
		}
		if err := tx.SaveTaskVersion(beforeTask, nextTask, options.Actor, now, ""); err != nil {
			return rollbackTimeMutation(tx, beforeTask, nil, beforeEntries, err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if err := service.indexTask(taskID); err != nil {
		return &entry, err
	}
	return &entry, nil
}

func activeTaskForTimeMutation(tx *storage.TaskLifecycleTransaction, taskID string) (*models.Task, error) {
	task, err := tx.GetTask(taskID)
	if err != nil {
		return nil, err
	}
	if task.Archived {
		return nil, fmt.Errorf("cannot mutate time for archived Task %q", taskID)
	}
	return task, nil
}

func completedEntryForTimer(state *models.TimeState, taskID string, now time.Time) (models.TimeEntry, *models.TimeState, error) {
	nextState := &models.TimeState{Active: make([]models.ActiveTimer, 0, len(state.Active))}
	var timer *models.ActiveTimer
	for index := range state.Active {
		if state.Active[index].TaskID == taskID {
			copy := state.Active[index]
			timer = &copy
			continue
		}
		nextState.Active = append(nextState.Active, state.Active[index])
	}
	if timer == nil {
		return models.TimeEntry{}, nil, fmt.Errorf("no active timer for task %q", taskID)
	}
	startedAt, err := parseTimerTime(timer.StartedAt)
	if err != nil {
		startedAt = now.Add(-time.Second)
	}
	pausedMillis := timer.TotalPausedMs
	if timer.PausedAt != nil {
		if pausedAt, err := parseTimerTime(*timer.PausedAt); err == nil {
			pausedMillis += now.Sub(pausedAt).Milliseconds()
		}
	}
	elapsed := now.Sub(startedAt).Milliseconds() - pausedMillis
	if elapsed < 0 {
		elapsed = 0
	}
	entry := models.TimeEntry{
		ID:        fmt.Sprintf("te-%d-%s", now.UnixMilli(), taskID),
		StartedAt: startedAt.UTC(),
		EndedAt:   timePointer(now),
		Duration:  int(elapsed / 1000),
	}
	return entry, nextState, nil
}

func parseTimerTime(value string) (time.Time, error) {
	for _, layout := range []string{"2006-01-02T15:04:05.000Z07:00", time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.000Z"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed, nil
		}
	}
	return time.Time{}, fmt.Errorf("cannot parse timer timestamp %q", value)
}

func cloneTimeState(state *models.TimeState) *models.TimeState {
	if state == nil {
		return &models.TimeState{Active: []models.ActiveTimer{}}
	}
	copy := &models.TimeState{Active: append([]models.ActiveTimer(nil), state.Active...)}
	for index := range copy.Active {
		if copy.Active[index].PausedAt != nil {
			paused := *copy.Active[index].PausedAt
			copy.Active[index].PausedAt = &paused
		}
	}
	return copy
}

func cloneTimeEntries(entries map[string][]models.TimeEntry) map[string][]models.TimeEntry {
	copy := make(map[string][]models.TimeEntry, len(entries))
	for taskID, taskEntries := range entries {
		copy[taskID] = append([]models.TimeEntry(nil), taskEntries...)
	}
	return copy
}

func totalTimeSpent(entries []models.TimeEntry) int {
	total := 0
	for _, entry := range entries {
		total += entry.Duration
	}
	return total
}

func rollbackTimeMutation(tx *storage.TaskLifecycleTransaction, task *models.Task, state *models.TimeState, entries map[string][]models.TimeEntry, cause error) error {
	var rollbackErrors []string
	if task != nil {
		if err := tx.UpdateTask(task); err != nil {
			rollbackErrors = append(rollbackErrors, "task: "+err.Error())
		}
	}
	if state != nil {
		if err := tx.SaveTimeState(state); err != nil {
			rollbackErrors = append(rollbackErrors, "timer: "+err.Error())
		}
	}
	if entries != nil {
		if err := tx.SaveAllTimeEntries(entries); err != nil {
			rollbackErrors = append(rollbackErrors, "entries: "+err.Error())
		}
	}
	if len(rollbackErrors) > 0 {
		return fmt.Errorf("%w; rollback time mutation: %s", cause, strings.Join(rollbackErrors, "; "))
	}
	return cause
}
