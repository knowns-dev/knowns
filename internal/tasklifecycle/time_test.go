package tasklifecycle

import (
	"context"
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
		entry, err := service.StopTimer(t.Context(), "time-stop-first", "test")
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
		if _, err := service.StopTimer(t.Context(), "time-active-first", "test"); err != nil {
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
