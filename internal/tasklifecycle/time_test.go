package tasklifecycle

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

func TestTimeMutationsRemainConsistentAcrossArchiveOrderings(t *testing.T) {
	now := time.Date(2026, 7, 22, 4, 0, 0, 0, time.UTC)

	t.Run("add then archive persists entry and matching Task total", func(t *testing.T) {
		store := newPublicLifecycleStore(t)
		createPublicLifecycleTask(t, store, "time-add-first", "done", now.Add(-time.Hour))
		service := New(store, WithClock(func() time.Time { return now }))
		endedAt := now.Add(-time.Minute)
		entry := models.TimeEntry{ID: "manual-1", StartedAt: endedAt.Add(-90 * time.Second), EndedAt: &endedAt, Duration: 90}
		if _, err := service.AddTimeEntry(t.Context(), "time-add-first", TimeMutationOptions{Actor: "test", Entry: entry}); err != nil {
			t.Fatalf("add time: %v", err)
		}
		if result, err := service.Archive(t.Context(), "time-add-first", ArchiveOptions{}); err != nil || !result.Changed {
			t.Fatalf("archive after add = %+v, %v", result, err)
		}
		assertTaskTimeConsistency(t, store, "time-add-first", 90, 1)
	})

	t.Run("archive then add rejects without time side effects", func(t *testing.T) {
		store := newPublicLifecycleStore(t)
		createPublicLifecycleTask(t, store, "time-archive-first", "done", now.Add(-time.Hour))
		service := New(store, WithClock(func() time.Time { return now }))
		if result, err := service.Archive(t.Context(), "time-archive-first", ArchiveOptions{}); err != nil || !result.Changed {
			t.Fatalf("archive: %+v, %v", result, err)
		}
		if _, err := service.AddTimeEntry(t.Context(), "time-archive-first", TimeMutationOptions{Entry: models.TimeEntry{ID: "manual-2", StartedAt: now, Duration: 30}}); err == nil {
			t.Fatal("add time to archived Task succeeded")
		}
		assertTaskTimeConsistency(t, store, "time-archive-first", 0, 0)
	})

	t.Run("stop then archive commits timer entry and Task version together", func(t *testing.T) {
		store := newPublicLifecycleStore(t)
		createPublicLifecycleTask(t, store, "time-stop-first", "done", now.Add(-time.Hour))
		if err := store.Time.SaveState(&models.TimeState{Active: []models.ActiveTimer{{TaskID: "time-stop-first", StartedAt: now.Add(-2 * time.Minute).Format(time.RFC3339Nano)}}}); err != nil {
			t.Fatal(err)
		}
		service := New(store, WithClock(func() time.Time { return now }))
		entry, err := service.StopTimer(t.Context(), "time-stop-first", StopTimerOptions{Actor: "test"})
		if err != nil || entry.Duration != 120 {
			t.Fatalf("stop = %+v, %v", entry, err)
		}
		if result, err := service.Archive(t.Context(), "time-stop-first", ArchiveOptions{}); err != nil || !result.Changed {
			t.Fatalf("archive after stop = %+v, %v", result, err)
		}
		assertTaskTimeConsistency(t, store, "time-stop-first", 120, 1)
		history, err := store.Versions.GetHistory("time-stop-first")
		if err != nil || len(history.Versions) < 2 {
			t.Fatalf("time/archive versions = %+v, %v", history, err)
		}
	})

	t.Run("archive while timer active skips, then stop remains consistent", func(t *testing.T) {
		store := newPublicLifecycleStore(t)
		createPublicLifecycleTask(t, store, "time-active-first", "done", now.Add(-time.Hour))
		if err := store.Time.SaveState(&models.TimeState{Active: []models.ActiveTimer{{TaskID: "time-active-first", StartedAt: now.Add(-time.Minute).Format(time.RFC3339Nano)}}}); err != nil {
			t.Fatal(err)
		}
		service := New(store, WithClock(func() time.Time { return now }))
		result, err := service.Archive(t.Context(), "time-active-first", ArchiveOptions{})
		if err != nil || result.Changed || len(result.Reasons) != 1 || result.Reasons[0].Code != ReasonActiveTimer {
			t.Fatalf("archive with timer = %+v, %v", result, err)
		}
		if _, err := service.StopTimer(t.Context(), "time-active-first", StopTimerOptions{Actor: "test"}); err != nil {
			t.Fatalf("stop after skipped archive: %v", err)
		}
		assertTaskTimeConsistency(t, store, "time-active-first", 60, 1)
	})
}

func TestTimeMutationIndexHookRunsOutsideLifecycleLockAndTombstoneRejects(t *testing.T) {
	now := time.Date(2026, 7, 22, 5, 0, 0, 0, time.UTC)
	store := newPublicLifecycleStore(t)
	createPublicLifecycleTask(t, store, "time-hook", "todo", time.Time{})
	service := New(store, WithClock(func() time.Time { return now }), WithHooks(Hooks{IndexTask: func(string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
		defer cancel()
		return store.WithTaskLifecycleTransaction(ctx, func(*storage.TaskLifecycleTransaction) error { return nil })
	}}))
	if _, err := service.AddTimeEntry(t.Context(), "time-hook", TimeMutationOptions{Entry: models.TimeEntry{ID: "hook-entry", StartedAt: now, Duration: 1}}); err != nil {
		t.Fatalf("outside-lock hook: %v", err)
	}
	if _, err := service.HardDelete(t.Context(), "time-hook", HardDeleteOptions{Confirmed: true, Reason: "cleanup"}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.AddTimeEntry(t.Context(), "time-hook", TimeMutationOptions{Entry: models.TimeEntry{ID: "after-delete", StartedAt: now, Duration: 1}}); err == nil {
		t.Fatal("hard-deleted Task accepted time entry")
	}
	entries, err := store.Time.GetEntries("time-hook")
	if err != nil || len(entries) != 0 {
		t.Fatalf("hard-delete time cleanup/rejection = %+v, %v", entries, err)
	}
}

func TestTimeMutationsRejectStaleTaskBaseWithoutSideEffects(t *testing.T) {
	now := time.Date(2026, 7, 22, 6, 0, 0, 0, time.UTC)
	t.Run("stop", func(t *testing.T) {
		store := newPublicLifecycleStore(t)
		createPublicLifecycleTask(t, store, "time-occ-stop", "todo", time.Time{})
		if err := store.Time.SaveState(&models.TimeState{Active: []models.ActiveTimer{{TaskID: "time-occ-stop", StartedAt: now.Add(-time.Minute).Format(time.RFC3339Nano)}}}); err != nil {
			t.Fatal(err)
		}
		var indexCalls int
		service := New(store, WithClock(func() time.Time { return now }), WithHooks(Hooks{IndexTask: func(string) error { indexCalls++; return nil }}))
		base, err := store.Tasks.Get("time-occ-stop")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := service.UpdateTask(t.Context(), base.ID, TaskUpdateOptions{ExpectedHash: base.CanonicalHash, Mutate: func(task *models.Task) error { task.Title = "changed"; return nil }}); err != nil {
			t.Fatal(err)
		}
		updated, _ := store.Tasks.Get(base.ID)
		beforeEntries, _ := store.Time.GetEntries(base.ID)
		beforeState, _ := store.Time.GetState()
		beforeHistory, _ := store.Versions.GetHistory(base.ID)
		beforeIndex := indexCalls
		_, err = service.StopTimer(t.Context(), base.ID, StopTimerOptions{Actor: "test", ExpectedHash: base.CanonicalHash})
		if !errors.Is(err, storage.ErrHistoryConflict) {
			t.Fatalf("stop error = %v, want history conflict", err)
		}
		after, _ := store.Tasks.Get(base.ID)
		afterEntries, _ := store.Time.GetEntries(base.ID)
		afterState, _ := store.Time.GetState()
		afterHistory, _ := store.Versions.GetHistory(base.ID)
		if after.CanonicalHash != updated.CanonicalHash || len(afterEntries) != len(beforeEntries) || afterState.Active[0].TaskID != beforeState.Active[0].TaskID || len(afterHistory.Versions) != len(beforeHistory.Versions) || indexCalls != beforeIndex {
			t.Fatalf("stale stop had side effects: task=%#v entries=%#v state=%#v history=%d/%d index=%d/%d", after, afterEntries, afterState, len(afterHistory.Versions), len(beforeHistory.Versions), indexCalls, beforeIndex)
		}
	})

	t.Run("add", func(t *testing.T) {
		store := newPublicLifecycleStore(t)
		createPublicLifecycleTask(t, store, "time-occ-add", "todo", time.Time{})
		service := New(store, WithClock(func() time.Time { return now }))
		base, err := store.Tasks.Get("time-occ-add")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := service.UpdateTask(t.Context(), base.ID, TaskUpdateOptions{ExpectedHash: base.CanonicalHash, Mutate: func(task *models.Task) error { task.Title = "changed"; return nil }}); err != nil {
			t.Fatal(err)
		}
		beforeEntries, _ := store.Time.GetEntries(base.ID)
		beforeHistory, _ := store.Versions.GetHistory(base.ID)
		_, err = service.AddTimeEntry(t.Context(), base.ID, TimeMutationOptions{Actor: "test", ExpectedHash: base.CanonicalHash, Entry: models.TimeEntry{ID: "stale-entry", StartedAt: now, Duration: 30}})
		if !errors.Is(err, storage.ErrHistoryConflict) {
			t.Fatalf("add error = %v, want history conflict", err)
		}
		after, _ := store.Tasks.Get(base.ID)
		afterEntries, _ := store.Time.GetEntries(base.ID)
		afterHistory, _ := store.Versions.GetHistory(base.ID)
		if after.TimeSpent != 0 || len(afterEntries) != len(beforeEntries) || len(afterHistory.Versions) != len(beforeHistory.Versions) {
			t.Fatalf("stale add had side effects: task=%#v entries=%#v history=%d/%d", after, afterEntries, len(afterHistory.Versions), len(beforeHistory.Versions))
		}
	})
}

func TestStopTimersRollsBackAllEntitiesOnLateHistoryFailure(t *testing.T) {
	now := time.Date(2026, 7, 22, 7, 0, 0, 0, time.UTC)
	store := newPublicLifecycleStore(t)
	createPublicLifecycleTask(t, store, "batch-stop-a", "todo", time.Time{})
	createPublicLifecycleTask(t, store, "batch-stop-z", "todo", time.Time{})
	if err := store.Time.SaveState(&models.TimeState{Active: []models.ActiveTimer{
		{TaskID: "batch-stop-a", StartedAt: now.Add(-time.Minute).Format(time.RFC3339Nano)},
		{TaskID: "batch-stop-z", StartedAt: now.Add(-2 * time.Minute).Format(time.RFC3339Nano)},
	}}); err != nil {
		t.Fatal(err)
	}
	badHistory := filepath.Join(store.Root, "history", "tasks", "batch-stop-z.jsonl")
	if err := os.MkdirAll(filepath.Dir(badHistory), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(badHistory, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(badHistory) })
	service := New(store, WithClock(func() time.Time { return now }))
	a, _ := store.Tasks.Get("batch-stop-a")
	z, _ := store.Tasks.Get("batch-stop-z")
	beforeState, _ := store.Time.GetState()
	beforeA, _ := store.Tasks.Get(a.ID)
	beforeZ, _ := store.Tasks.Get(z.ID)
	beforeEntriesA, _ := store.Time.GetEntries(a.ID)
	beforeEntriesZ, _ := store.Time.GetEntries(z.ID)
	beforeHistoryA, _ := store.Versions.GetHistory(a.ID)
	beforeHistoryZ, _ := store.Versions.GetHistory(z.ID)
	_, err := service.StopTimers(t.Context(), []string{a.ID, z.ID}, StopTimersOptions{Actor: "test", ExpectedHashes: map[string]string{a.ID: a.CanonicalHash, z.ID: z.CanonicalHash}})
	if err == nil {
		t.Fatal("batch stop unexpectedly succeeded with injected history failure")
	}
	afterState, _ := store.Time.GetState()
	afterA, _ := store.Tasks.Get(a.ID)
	afterZ, _ := store.Tasks.Get(z.ID)
	afterEntriesA, _ := store.Time.GetEntries(a.ID)
	afterEntriesZ, _ := store.Time.GetEntries(z.ID)
	afterHistoryA, _ := store.Versions.GetHistory(a.ID)
	afterHistoryZ, _ := store.Versions.GetHistory(z.ID)
	if !reflect.DeepEqual(afterState, beforeState) || !reflect.DeepEqual(afterA, beforeA) || !reflect.DeepEqual(afterZ, beforeZ) || !reflect.DeepEqual(afterEntriesA, beforeEntriesA) || !reflect.DeepEqual(afterEntriesZ, beforeEntriesZ) || !reflect.DeepEqual(afterHistoryA, beforeHistoryA) || !reflect.DeepEqual(afterHistoryZ, beforeHistoryZ) {
		t.Fatalf("late batch stop was not rolled back: state=%#v/%#v A=%#v/%#v Z=%#v/%#v entries=%#v/%#v history=%d/%d,%d/%d", afterState, beforeState, afterA, beforeA, afterZ, beforeZ, afterEntriesA, beforeEntriesA, len(afterHistoryA.Versions), len(beforeHistoryA.Versions), len(afterHistoryZ.Versions), len(beforeHistoryZ.Versions))
	}
}

func assertTaskTimeConsistency(t *testing.T, store *storage.Store, taskID string, wantSeconds, wantEntries int) {
	t.Helper()
	task, err := store.Tasks.Get(taskID)
	if err != nil {
		t.Fatal(err)
	}
	entries, err := store.Time.GetEntries(taskID)
	if err != nil {
		t.Fatal(err)
	}
	total := 0
	for _, entry := range entries {
		total += entry.Duration
	}
	if task.TimeSpent != wantSeconds || total != wantSeconds || len(entries) != wantEntries {
		t.Fatalf("Task.TimeSpent=%d entry total=%d entries=%d, want %d/%d", task.TimeSpent, total, len(entries), wantSeconds, wantEntries)
	}
}
