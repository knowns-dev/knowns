package storage

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

// TimeStore reads and writes .knowns/time.json and .knowns/time-entries.json.
type TimeStore struct {
	root          string
	lifecycleLock *taskLifecycleLock
}

func (ts *TimeStore) statePath() string   { return filepath.Join(ts.root, "time.json") }
func (ts *TimeStore) entriesPath() string { return filepath.Join(ts.root, "time-entries.json") }

// GetActiveTimer returns the active timer for a specific task, or nil if none.
func (ts *TimeStore) GetActiveTimer(taskID string) *models.ActiveTimer {
	timer, _ := ts.GetActiveTimerWithError(taskID)
	return timer
}

// GetActiveTimerWithError returns the active timer without hiding unreadable or
// corrupt timer state. Lifecycle eligibility uses this fail-closed path.
func (ts *TimeStore) GetActiveTimerWithError(taskID string) (*models.ActiveTimer, error) {
	state, err := ts.GetState()
	if err != nil {
		return nil, err
	}
	for i := range state.Active {
		if state.Active[i].TaskID == taskID {
			return &state.Active[i], nil
		}
	}
	return nil, nil
}

// GetState returns the current timer state from time.json.
func (ts *TimeStore) GetState() (*models.TimeState, error) {
	data, err := os.ReadFile(ts.statePath())
	if os.IsNotExist(err) {
		return &models.TimeState{Active: []models.ActiveTimer{}}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read time.json: %w", err)
	}
	var state models.TimeState
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, fmt.Errorf("parse time.json: %w", err)
	}
	if state.Active == nil {
		state.Active = []models.ActiveTimer{}
	}
	return &state, nil
}

// SaveState writes the timer state to time.json.
func (ts *TimeStore) SaveState(state *models.TimeState) error {
	return ts.withLifecycleLock(func() error { return ts.saveStateUnlocked(state) })
}

func (ts *TimeStore) saveStateUnlocked(state *models.TimeState) error {
	if state.Active == nil {
		state.Active = []models.ActiveTimer{}
	}
	return writeJSON(ts.statePath(), state)
}

// GetEntries returns all time entries for a specific task.
func (ts *TimeStore) GetEntries(taskID string) ([]models.TimeEntry, error) {
	all, err := ts.GetAllEntries()
	if err != nil {
		return nil, err
	}
	return all[taskID], nil
}

// GetAllEntries returns the full time-entries map (taskID -> []TimeEntry).
func (ts *TimeStore) GetAllEntries() (map[string][]models.TimeEntry, error) {
	data, err := os.ReadFile(ts.entriesPath())
	if os.IsNotExist(err) {
		return make(map[string][]models.TimeEntry), nil
	}
	if err != nil {
		return nil, fmt.Errorf("read time-entries.json: %w", err)
	}
	var m map[string][]models.TimeEntry
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("parse time-entries.json: %w", err)
	}
	if m == nil {
		m = make(map[string][]models.TimeEntry)
	}
	return m, nil
}

// SaveEntry appends a completed time entry for the given task.
func (ts *TimeStore) SaveEntry(taskID string, entry models.TimeEntry) error {
	return ts.withLifecycleLock(func() error { return ts.saveEntryUnlocked(taskID, entry) })
}

func (ts *TimeStore) saveEntryUnlocked(taskID string, entry models.TimeEntry) error {
	if err := ts.rejectHardDeletedTask(taskID); err != nil {
		return err
	}
	task, err := (&TaskStore{root: ts.root}).Get(taskID)
	if err != nil {
		return fmt.Errorf("cannot save time data for Task %q: %w", taskID, err)
	}
	if task.Archived {
		return fmt.Errorf("cannot save time data for archived Task %q", taskID)
	}
	all, err := ts.GetAllEntries()
	if err != nil {
		return err
	}
	all[taskID] = append(all[taskID], entry)
	return ts.saveAllEntriesUnlocked(all)
}

func (ts *TimeStore) saveAllEntriesUnlocked(all map[string][]models.TimeEntry) error {
	if all == nil {
		all = make(map[string][]models.TimeEntry)
	}
	return writeJSON(ts.entriesPath(), all)
}

// Start begins a new timer for the given task.
// Returns an error if a timer for that task is already running.
func (ts *TimeStore) Start(taskID, taskTitle string) error {
	return ts.withLifecycleLock(func() error { return ts.startUnlocked(taskID, taskTitle) })
}

func (ts *TimeStore) startUnlocked(taskID, taskTitle string) error {
	if err := ts.rejectHardDeletedTask(taskID); err != nil {
		return err
	}
	task, err := (&TaskStore{root: ts.root}).Get(taskID)
	if err != nil {
		return fmt.Errorf("start timer: %w", err)
	}
	if task.Archived {
		return fmt.Errorf("cannot start timer for archived Task %q", taskID)
	}
	state, err := ts.GetState()
	if err != nil {
		return err
	}
	for _, a := range state.Active {
		if a.TaskID == taskID {
			return fmt.Errorf("timer already running for task %q", taskID)
		}
	}
	now := isoNow()
	state.Active = append(state.Active, models.ActiveTimer{
		TaskID:        taskID,
		TaskTitle:     taskTitle,
		StartedAt:     now,
		PausedAt:      nil,
		TotalPausedMs: 0,
	})
	return ts.saveStateUnlocked(state)
}

// Stop stops the active timer for a task and records a completed TimeEntry.
// Returns the recorded entry.
func (ts *TimeStore) Stop(taskID string) (*models.TimeEntry, error) {
	var entry *models.TimeEntry
	err := ts.withLifecycleLock(func() error {
		var err error
		entry, err = ts.stopUnlocked(taskID)
		return err
	})
	return entry, err
}

func (ts *TimeStore) stopUnlocked(taskID string) (*models.TimeEntry, error) {
	state, err := ts.GetState()
	if err != nil {
		return nil, err
	}

	var timer *models.ActiveTimer
	remaining := make([]models.ActiveTimer, 0, len(state.Active))
	for i := range state.Active {
		if state.Active[i].TaskID == taskID {
			c := state.Active[i]
			timer = &c
		} else {
			remaining = append(remaining, state.Active[i])
		}
	}
	if timer == nil {
		return nil, fmt.Errorf("no active timer for task %q", taskID)
	}

	now := time.Now().UTC()
	nowStr := isoNow()

	startedAt, err := parseISO(timer.StartedAt)
	if err != nil {
		startedAt = now.Add(-1 * time.Second)
	}

	// Account for paused time.
	pausedMs := timer.TotalPausedMs
	if timer.PausedAt != nil {
		if pausedAt, err := parseISO(*timer.PausedAt); err == nil {
			pausedMs += now.Sub(pausedAt).Milliseconds()
		}
	}

	elapsed := now.Sub(startedAt).Milliseconds() - pausedMs
	if elapsed < 0 {
		elapsed = 0
	}
	durationSecs := int(elapsed / 1000)

	entryID := fmt.Sprintf("te-%d-%s", now.UnixMilli(), taskID)
	entry := models.TimeEntry{
		ID:        entryID,
		StartedAt: startedAt,
		EndedAt:   &now,
		Duration:  durationSecs,
	}

	// Save the entry and update state.
	if err := ts.saveEntryUnlocked(taskID, entry); err != nil {
		return nil, fmt.Errorf("save entry: %w", err)
	}

	_ = nowStr // used for pause tracking above
	state.Active = remaining
	if err := ts.saveStateUnlocked(state); err != nil {
		return nil, fmt.Errorf("save state: %w", err)
	}
	return &entry, nil
}

// Pause pauses the active timer for a task.
func (ts *TimeStore) Pause(taskID string) error {
	return ts.withLifecycleLock(func() error { return ts.pauseUnlocked(taskID) })
}

func (ts *TimeStore) pauseUnlocked(taskID string) error {
	state, err := ts.GetState()
	if err != nil {
		return err
	}
	for i := range state.Active {
		if state.Active[i].TaskID == taskID {
			if state.Active[i].PausedAt != nil {
				return fmt.Errorf("timer for task %q is already paused", taskID)
			}
			now := isoNow()
			state.Active[i].PausedAt = &now
			return ts.saveStateUnlocked(state)
		}
	}
	return fmt.Errorf("no active timer for task %q", taskID)
}

// Resume resumes a paused timer for a task.
func (ts *TimeStore) Resume(taskID string) error {
	return ts.withLifecycleLock(func() error { return ts.resumeUnlocked(taskID) })
}

func (ts *TimeStore) resumeUnlocked(taskID string) error {
	state, err := ts.GetState()
	if err != nil {
		return err
	}
	for i := range state.Active {
		if state.Active[i].TaskID == taskID {
			if state.Active[i].PausedAt == nil {
				return fmt.Errorf("timer for task %q is not paused", taskID)
			}
			pausedAt, err := parseISO(*state.Active[i].PausedAt)
			if err == nil {
				state.Active[i].TotalPausedMs += time.Now().UTC().Sub(pausedAt).Milliseconds()
			}
			state.Active[i].PausedAt = nil
			return ts.saveStateUnlocked(state)
		}
	}
	return fmt.Errorf("no active timer for task %q", taskID)
}

func (ts *TimeStore) withLifecycleLock(fn func() error) error {
	if ts.lifecycleLock == nil {
		return fn()
	}
	return ts.lifecycleLock.with(context.Background(), fn)
}

func (ts *TimeStore) rejectHardDeletedTask(taskID string) error {
	reserved, err := (&TaskStore{root: ts.root}).IsIDReserved(taskID)
	if err != nil {
		return fmt.Errorf("check Task tombstone before saving time data: %w", err)
	}
	if reserved {
		return fmt.Errorf("cannot save time data for hard-deleted Task %q", taskID)
	}
	return nil
}

// isoNow returns the current UTC time formatted as an ISO 8601 string.
func isoNow() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}
