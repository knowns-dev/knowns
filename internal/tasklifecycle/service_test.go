package tasklifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

var fixedNow = time.Date(2026, 7, 22, 10, 0, 0, 0, time.UTC)

func TestEvaluateUsesCompletedAtActiveTimerAndAllDescendants(t *testing.T) {
	store := newLifecycleStore(t)
	completedAt := fixedNow.Add(-31 * 24 * time.Hour)
	root := lifecycleTask("root01", "done", "")
	root.CompletedAt = &completedAt
	root.UpdatedAt = fixedNow
	createLifecycleTask(t, store, root)
	createLifecycleTask(t, store, lifecycleTask("child1", "done", root.ID))
	createLifecycleTask(t, store, lifecycleTask("grand1", "in-progress", "child1"))
	if err := store.Time.Start(root.ID, root.Title); err != nil {
		t.Fatalf("start timer: %v", err)
	}

	service := New(store, WithClock(func() time.Time { return fixedNow }))
	eligibility, err := service.Evaluate(context.Background(), root.ID, ArchiveOptions{Automatic: true})
	if err != nil {
		t.Fatalf("Evaluate: %v", err)
	}
	if eligibility.Eligible {
		t.Fatal("eligible = true, want blockers")
	}
	codes := reasonCodes(eligibility.Reasons)
	wantCodes := []ReasonCode{ReasonActiveTimer, ReasonUnfinishedDescendant}
	if !reflect.DeepEqual(codes, wantCodes) {
		t.Fatalf("reason codes = %v, want %v", codes, wantCodes)
	}
	if got := eligibility.Reasons[1].RelatedTaskID; got != "grand1" {
		t.Fatalf("descendant blocker = %q, want grand1", got)
	}
	if eligibility.Deadline == nil || !eligibility.Deadline.Equal(completedAt.Add(30*24*time.Hour)) {
		t.Fatalf("deadline = %v, want completion-based deadline", eligibility.Deadline)
	}
}

func TestAutoArchiveUsesCompletedAtAndDistinguishesZeroFromDisabled(t *testing.T) {
	t.Run("completedAt not updatedAt", func(t *testing.T) {
		store := newLifecycleStore(t)
		completedAt := fixedNow.Add(-31 * 24 * time.Hour)
		task := lifecycleTask("age001", "done", "")
		task.CompletedAt = &completedAt
		task.UpdatedAt = fixedNow
		createLifecycleTask(t, store, task)

		batch, err := New(store, WithClock(func() time.Time { return fixedNow })).AutoArchive(context.Background(), "sweeper")
		if err != nil {
			t.Fatalf("AutoArchive: %v", err)
		}
		if batch.Changed != 1 {
			t.Fatalf("changed = %d, want 1", batch.Changed)
		}
		assertArchived(t, store, task.ID, true)
	})

	t.Run("zero delay", func(t *testing.T) {
		store := newLifecycleStore(t)
		setLifecycleSettings(t, store, models.TaskLifecycleSettings{AutoArchive: true, ArchiveAfter: "0s", ExcludeDoneFromDefaultRetrieval: true})
		task := lifecycleTask("zero01", "done", "")
		task.CompletedAt = timePointer(fixedNow)
		createLifecycleTask(t, store, task)
		batch, err := New(store, WithClock(func() time.Time { return fixedNow })).AutoArchive(context.Background(), "sweeper")
		if err != nil || batch.Changed != 1 {
			t.Fatalf("AutoArchive zero = %#v, %v", batch, err)
		}
	})

	t.Run("disabled", func(t *testing.T) {
		store := newLifecycleStore(t)
		setLifecycleSettings(t, store, models.TaskLifecycleSettings{AutoArchive: false, ArchiveAfter: "0s", ExcludeDoneFromDefaultRetrieval: true})
		task := lifecycleTask("off001", "done", "")
		task.CompletedAt = timePointer(fixedNow.Add(-time.Hour))
		createLifecycleTask(t, store, task)
		batch, err := New(store, WithClock(func() time.Time { return fixedNow })).AutoArchive(context.Background(), "sweeper")
		if err != nil {
			t.Fatalf("AutoArchive disabled: %v", err)
		}
		if batch.Changed != 0 || len(batch.Items) != 1 || batch.Items[0].Reasons[0].Code != ReasonAutoArchiveDisabled {
			t.Fatalf("disabled batch = %#v", batch)
		}
		assertArchived(t, store, task.ID, false)
	})
}

func TestAutoArchiveWithoutIDsRepairsArchivedPendingCheckpoint(t *testing.T) {
	store := newLifecycleStore(t)
	task := lifecycleTask("auto-retry", "done", "")
	task.CompletedAt = timePointer(fixedNow.Add(-31 * 24 * time.Hour))
	createLifecycleTask(t, store, task)

	var indexAttempts atomic.Int32
	var eventsMu sync.Mutex
	var events []Event
	service := New(store,
		WithClock(func() time.Time { return fixedNow }),
		WithHooks(Hooks{
			IndexTask: func(string) error {
				if indexAttempts.Add(1) == 1 {
					return errors.New("index unavailable")
				}
				return nil
			},
			Emit: func(event Event) error {
				eventsMu.Lock()
				defer eventsMu.Unlock()
				events = append(events, event)
				return nil
			},
		}))

	first, err := service.AutoArchive(context.Background(), "sweeper")
	if err == nil || !strings.Contains(err.Error(), "index unavailable") {
		t.Fatalf("first AutoArchive error = %v", err)
	}
	if !first.Completed || first.Processed != 1 || first.Changed != 1 || first.FailedTaskID != task.ID {
		t.Fatalf("first AutoArchive = %#v", first)
	}
	assertArchived(t, store, task.ID, true)
	if got := pendingLifecycleRecords(t, store, string(OperationArchive)); len(got) != 1 || !got[0].EventDelivered || got[0].DerivedApplied {
		t.Fatalf("pending after failed index = %#v", got)
	}

	// No explicit IDs are supplied on retry. The active Task list is empty, so
	// the pending checkpoint is the only way to rediscover and repair this ID.
	retry, err := service.AutoArchive(context.Background(), "sweeper")
	if err != nil {
		t.Fatalf("retry AutoArchive: %v", err)
	}
	if !retry.Completed || retry.Processed != 1 || retry.Changed != 0 || retry.FailedTaskID != "" {
		t.Fatalf("retry AutoArchive = %#v", retry)
	}
	if indexAttempts.Load() != 2 || len(events) != 1 || events[0].ID == "" {
		t.Fatalf("retry side effects: index=%d events=%#v", indexAttempts.Load(), events)
	}
	if got := pendingLifecycleRecords(t, store, string(OperationArchive)); len(got) != 0 {
		t.Fatalf("pending after repair = %#v", got)
	}
}

func TestArchiveAndReopenResumeEveryProcessDeathBoundary(t *testing.T) {
	boundaries := []string{
		"pending_to_move",
		"move_to_patch",
		"patch_to_version",
		"version_to_canonical",
		"canonical_to_event",
		"event_to_derived",
	}
	for _, operation := range []Operation{OperationArchive, OperationReopen} {
		for _, boundary := range boundaries {
			t.Run(string(operation)+"/"+boundary, func(t *testing.T) {
				store := newLifecycleStore(t)
				task := lifecycleTask("crash-"+string(operation)+"-"+boundary, "done", "")
				task.CompletedAt = timePointer(fixedNow.Add(-time.Hour))
				if operation == OperationReopen {
					task.ArchivedAt = timePointer(fixedNow.Add(-30 * time.Minute))
				}
				createLifecycleTask(t, store, task)
				if operation == OperationReopen {
					if err := store.Tasks.Archive(task.ID); err != nil {
						t.Fatalf("seed archived Task: %v", err)
					}
				}
				original, err := store.Tasks.Get(task.ID)
				if err != nil {
					t.Fatalf("get original: %v", err)
				}
				desired := cloneTask(original)
				if operation == OperationArchive {
					desired.Archived = true
					desired.ArchivedAt = timePointer(fixedNow)
					desired.UpdatedAt = fixedNow
				} else {
					desired.Archived = false
					desired.Status = "todo"
					desired.CompletedAt = nil
					desired.ArchivedAt = nil
					desired.UpdatedAt = fixedNow
				}
				event := Event{
					ID: "event-" + string(operation) + "-" + boundary, Type: operation,
					TaskID: task.ID, At: fixedNow, Actor: "crash-test",
					From: original.LifecycleState(), To: desired.LifecycleState(),
				}
				pending := pendingForTransition(event, original, desired)
				seedInterruptedLifecycleBoundary(t, store, pending, original, desired, boundary)

				var eventCalls, indexCalls atomic.Int32
				service := New(store,
					WithClock(func() time.Time { return fixedNow.Add(time.Hour) }),
					WithHooks(Hooks{
						Emit: func(got Event) error {
							if got.ID != event.ID || got.From != event.From || got.To != event.To {
								return fmt.Errorf("event changed across retry: %#v", got)
							}
							eventCalls.Add(1)
							return nil
						},
						IndexTask: func(string) error { indexCalls.Add(1); return nil },
					}),
				)
				if operation == OperationArchive {
					_, err = service.Archive(context.Background(), task.ID, ArchiveOptions{Actor: "ignored-on-resume"})
				} else {
					_, err = service.Reopen(context.Background(), task.ID, ReopenOptions{Actor: "ignored-on-resume", Status: "in-progress"})
				}
				if err != nil {
					t.Fatalf("resume %s at %s: %v", operation, boundary, err)
				}
				loaded, err := store.Tasks.Get(task.ID)
				if err != nil || !lifecycleDataMatches(loaded, lifecycleDataFromTask(desired)) {
					t.Fatalf("resumed Task = %#v, err=%v, want lifecycle %#v", loaded, err, lifecycleDataFromTask(desired))
				}
				history, err := store.Versions.GetHistory(task.ID)
				if err != nil || countLifecycleEvent(history, event.ID) != 1 {
					t.Fatalf("history after resume = %#v, err=%v", history, err)
				}
				wantEvents := int32(1)
				if boundary == "event_to_derived" {
					wantEvents = 0
				}
				if eventCalls.Load() != wantEvents || indexCalls.Load() != 1 {
					t.Fatalf("side effects after resume: event=%d want=%d index=%d", eventCalls.Load(), wantEvents, indexCalls.Load())
				}
				if records := pendingLifecycleRecords(t, store, string(operation)); len(records) != 0 {
					t.Fatalf("pending after resume = %#v", records)
				}
			})
		}
	}
}

func TestPendingRecordsPreserveMultipleSameOperationEvents(t *testing.T) {
	store := newLifecycleStore(t)
	task := lifecycleTask("multi-event", "done", "")
	task.CompletedAt = timePointer(fixedNow.Add(-time.Hour))
	createLifecycleTask(t, store, task)

	clock := fixedNow
	failing := New(store,
		WithClock(func() time.Time { return clock }),
		WithHooks(Hooks{Emit: func(Event) error { return errors.New("sink unavailable") }}),
	)
	if _, err := failing.Archive(context.Background(), task.ID, ArchiveOptions{}); err != nil {
		t.Fatalf("first Archive: %v", err)
	}
	clock = clock.Add(time.Minute)
	if _, err := failing.Reopen(context.Background(), task.ID, ReopenOptions{}); err != nil {
		t.Fatalf("Reopen: %v", err)
	}
	active, err := store.Tasks.Get(task.ID)
	if err != nil {
		t.Fatalf("get reopened Task: %v", err)
	}
	ApplyStatusTransition(active, "done", clock)
	if err := store.Tasks.Update(active); err != nil {
		t.Fatalf("complete reopened Task: %v", err)
	}
	clock = clock.Add(time.Minute)
	if _, err := failing.Archive(context.Background(), task.ID, ArchiveOptions{}); err != nil {
		t.Fatalf("second Archive: %v", err)
	}

	records := pendingLifecycleRecords(t, store, "")
	if len(records) != 3 {
		t.Fatalf("pending events were overwritten: %#v", records)
	}
	seen := map[string]bool{}
	for _, record := range records {
		if seen[record.EventID] {
			t.Fatalf("duplicate pending event ID %q", record.EventID)
		}
		seen[record.EventID] = true
	}

	var delivered []Event
	success := New(store, WithClock(func() time.Time { return clock.Add(time.Minute) }), WithHooks(Hooks{
		Emit: func(event Event) error { delivered = append(delivered, event); return nil },
	}))
	if _, err := success.Archive(context.Background(), task.ID, ArchiveOptions{}); err != nil {
		t.Fatalf("flush preserved events: %v", err)
	}
	if len(delivered) != 3 || delivered[0].Type != OperationArchive || delivered[1].Type != OperationReopen || delivered[2].Type != OperationArchive {
		t.Fatalf("delivered events = %#v", delivered)
	}
	if delivered[0].ID == delivered[2].ID || !seen[delivered[0].ID] || !seen[delivered[2].ID] {
		t.Fatalf("archive event identities were not preserved: %#v", delivered)
	}
	if records := pendingLifecycleRecords(t, store, ""); len(records) != 0 {
		t.Fatalf("pending after delivery = %#v", records)
	}
}

func TestPendingClaimsPreventConcurrentHookInvocationAndKeepAtLeastOnceIdentity(t *testing.T) {
	t.Run("concurrent flushers", func(t *testing.T) {
		store, task, pending := seedCanonicalArchivePending(t, "claim-concurrent")
		started := make(chan struct{})
		release := make(chan struct{})
		var events, indexes atomic.Int32
		service := New(store, WithClock(func() time.Time { return fixedNow }), WithHooks(Hooks{
			Emit: func(event Event) error {
				if event.ID != pending.EventID {
					return fmt.Errorf("event ID = %q", event.ID)
				}
				if events.Add(1) == 1 {
					close(started)
				}
				<-release
				return nil
			},
			IndexTask: func(string) error { indexes.Add(1); return nil },
		}))
		errCh := make(chan error, 2)
		go func() { _, err := service.Archive(context.Background(), task.ID, ArchiveOptions{}); errCh <- err }()
		<-started
		go func() { _, err := service.Archive(context.Background(), task.ID, ArchiveOptions{}); errCh <- err }()
		time.Sleep(25 * time.Millisecond)
		if events.Load() != 1 {
			t.Fatalf("concurrent event invocations = %d", events.Load())
		}
		close(release)
		for range 2 {
			if err := <-errCh; err != nil {
				t.Fatalf("concurrent Archive: %v", err)
			}
		}
		if events.Load() != 1 || indexes.Load() != 1 {
			t.Fatalf("concurrent side effects: events=%d indexes=%d", events.Load(), indexes.Load())
		}
	})

	t.Run("expired crash lease retries same stable ID", func(t *testing.T) {
		store, task, pending := seedCanonicalArchivePending(t, "claim-crash")
		pending.EventClaim = &models.TaskLifecycleClaim{Token: "dead-process", ClaimedAt: fixedNow.Add(-taskLifecycleClaimLease - time.Second)}
		savePendingLifecycleRecord(t, store, pending)
		seenIDs := []string{pending.EventID} // external sink saw this before the process died
		service := New(store, WithClock(func() time.Time { return fixedNow }), WithHooks(Hooks{
			Emit: func(event Event) error { seenIDs = append(seenIDs, event.ID); return nil },
		}))
		if _, err := service.Archive(context.Background(), task.ID, ArchiveOptions{}); err != nil {
			t.Fatalf("retry expired claim: %v", err)
		}
		if len(seenIDs) != 2 || seenIDs[0] != seenIDs[1] {
			t.Fatalf("at-least-once retry changed event identity: %v", seenIDs)
		}
	})
}

func TestArchivePreservesTaskAndHistoryAndReturnsDurableKnowledgeWarning(t *testing.T) {
	store := newLifecycleStore(t)
	completedAt := fixedNow.Add(-time.Hour)
	order := 20
	task := lifecycleTask("full01", "done", "")
	task.Description = "Implements @doc/guides/lifecycle."
	task.CompletedAt = &completedAt
	task.Assignee = "owner"
	task.Labels = []string{"one", "two"}
	task.Spec = "specs/lifecycle"
	task.Fulfills = []string{"AC1"}
	task.Order = &order
	task.TimeSpent = 42
	task.AcceptanceCriteria = []models.AcceptanceCriterion{{Text: "kept", Completed: true}}
	task.ImplementationPlan = "Plan with @decision/keep01"
	task.ImplementationNotes = "Notes with @memory/keep02"
	createLifecycleTask(t, store, task)
	if err := store.Versions.SaveVersion(task.ID, models.TaskVersion{Timestamp: fixedNow.Add(-time.Hour), Snapshot: storage.TaskToSnapshot(task)}); err != nil {
		t.Fatalf("seed history: %v", err)
	}

	var indexed atomic.Int32
	service := New(store,
		WithClock(func() time.Time { return fixedNow }),
		WithHooks(Hooks{IndexTask: func(id string) error { indexed.Add(1); return nil }}),
	)
	result, err := service.Archive(context.Background(), task.ID, ArchiveOptions{Actor: "tester"})
	if err != nil {
		t.Fatalf("Archive: %v", err)
	}
	if !result.Changed || result.After != models.TaskLifecycleArchived || indexed.Load() != 1 {
		t.Fatalf("archive result = %#v indexed=%d", result, indexed.Load())
	}
	if len(result.Warnings) != 1 || result.Warnings[0].Code != WarningDurableKnowledge {
		t.Fatalf("warnings = %#v", result.Warnings)
	}
	wantRefs := []string{"@decision/keep01", "@doc/guides/lifecycle", "@memory/keep02"}
	if !reflect.DeepEqual(result.Warnings[0].References, wantRefs) {
		t.Fatalf("warning refs = %v, want %v", result.Warnings[0].References, wantRefs)
	}

	loaded, err := store.Tasks.Get(task.ID)
	if err != nil {
		t.Fatalf("Get archived: %v", err)
	}
	if !loaded.Archived || loaded.Description != task.Description || loaded.ImplementationPlan != task.ImplementationPlan || loaded.ImplementationNotes != task.ImplementationNotes || loaded.Spec != task.Spec || !reflect.DeepEqual(loaded.Fulfills, task.Fulfills) || !reflect.DeepEqual(loaded.AcceptanceCriteria, task.AcceptanceCriteria) || loaded.TimeSpent != task.TimeSpent {
		t.Fatalf("archived Task lost content: %#v", loaded)
	}
	history, err := store.Versions.GetHistory(task.ID)
	if err != nil || len(history.Versions) != 2 {
		t.Fatalf("history = %#v, %v", history, err)
	}
	last := history.Versions[len(history.Versions)-1]
	if !hasChange(last.Changes, "archived") || !hasChange(last.Changes, "archivedAt") {
		t.Fatalf("archive history changes = %#v", last.Changes)
	}
}

func TestArchiveAndReopenPreserveUnknownFrontmatterAndCustomMarkdown(t *testing.T) {
	store := newLifecycleStore(t)
	task := lifecycleTask("raw001", "done", "")
	task.CompletedAt = timePointer(fixedNow.Add(-time.Hour))
	createLifecycleTask(t, store, task)
	activePath := taskFilePath(t, store.Root, "tasks", task.ID)
	data, err := os.ReadFile(activePath)
	if err != nil {
		t.Fatalf("read active Task: %v", err)
	}
	content := strings.Replace(string(data), "timeSpent: 0\n", "timeSpent: 0\ncustomLifecycleData:\n  owner: keep-me\n  flags:\n    - alpha\n", 1)
	customBody := "\n## Custom Extension\n\n<!-- CUSTOM:BEGIN -->\nraw   spacing\n<!-- CUSTOM:END -->\n"
	content += customBody
	if err := os.WriteFile(activePath, []byte(content), 0o644); err != nil {
		t.Fatalf("seed custom Task content: %v", err)
	}

	service := New(store, WithClock(func() time.Time { return fixedNow }))
	if _, err := service.Archive(context.Background(), task.ID, ArchiveOptions{}); err != nil {
		t.Fatalf("Archive: %v", err)
	}
	archivedPath := taskFilePath(t, store.Root, "archive", task.ID)
	archivedRaw, err := os.ReadFile(archivedPath)
	if err != nil {
		t.Fatalf("read archived Task: %v", err)
	}
	if !strings.Contains(string(archivedRaw), "customLifecycleData:\n  owner: keep-me\n  flags:\n    - alpha\n") || !strings.HasSuffix(string(archivedRaw), customBody) {
		t.Fatalf("archive discarded custom content:\n%s", archivedRaw)
	}

	if _, err := service.Reopen(context.Background(), task.ID, ReopenOptions{}); err != nil {
		t.Fatalf("Reopen: %v", err)
	}
	reopenedPath := taskFilePath(t, store.Root, "tasks", task.ID)
	reopenedRaw, err := os.ReadFile(reopenedPath)
	if err != nil {
		t.Fatalf("read reopened Task: %v", err)
	}
	if !strings.Contains(string(reopenedRaw), "customLifecycleData:\n  owner: keep-me\n  flags:\n    - alpha\n") || !strings.HasSuffix(string(reopenedRaw), customBody) {
		t.Fatalf("reopen discarded custom content:\n%s", reopenedRaw)
	}
}

func TestArchiveAndReopenPreserveCRLFRawExtensions(t *testing.T) {
	store := newLifecycleStore(t)
	task := lifecycleTask("raw-crlf", "done", "")
	task.CompletedAt = timePointer(fixedNow.Add(-time.Hour))
	createLifecycleTask(t, store, task)
	activePath := taskFilePath(t, store.Root, "tasks", task.ID)
	raw, err := os.ReadFile(activePath)
	if err != nil {
		t.Fatalf("read active Task: %v", err)
	}
	content := strings.ReplaceAll(string(raw), "\n", "\r\n")
	unknown := "customLifecycleData:\r\n  owner: keep-me\r\n  flags:\r\n    - alpha\r\n"
	content = strings.Replace(content, "timeSpent: 0\r\n", "timeSpent: 0\r\n"+unknown, 1)
	customBody := "\r\n## CRLF Extension\r\n\r\n<!-- CUSTOM:BEGIN -->\r\nraw   spacing\r\n<!-- CUSTOM:END -->\r\n"
	content += customBody
	if err := os.WriteFile(activePath, []byte(content), 0o644); err != nil {
		t.Fatalf("seed CRLF Task: %v", err)
	}

	service := New(store, WithClock(func() time.Time { return fixedNow }))
	if _, err := service.Archive(context.Background(), task.ID, ArchiveOptions{}); err != nil {
		t.Fatalf("Archive: %v", err)
	}
	assertCRLFRawExtensions(t, taskFilePath(t, store.Root, "archive", task.ID), unknown, customBody)
	if _, err := service.Reopen(context.Background(), task.ID, ReopenOptions{}); err != nil {
		t.Fatalf("Reopen: %v", err)
	}
	assertCRLFRawExtensions(t, taskFilePath(t, store.Root, "tasks", task.ID), unknown, customBody)
}

func TestReopenArchivedTaskIsIdempotentAndPreservesHistory(t *testing.T) {
	store := newLifecycleStore(t)
	completedAt := fixedNow.Add(-time.Hour)
	task := lifecycleTask("open01", "done", "")
	task.CompletedAt = &completedAt
	createLifecycleTask(t, store, task)
	service := New(store, WithClock(func() time.Time { return fixedNow }))
	if _, err := service.Archive(context.Background(), task.ID, ArchiveOptions{}); err != nil {
		t.Fatalf("Archive: %v", err)
	}

	var indexed atomic.Int32
	service = New(store,
		WithClock(func() time.Time { return fixedNow.Add(time.Minute) }),
		WithHooks(Hooks{IndexTask: func(id string) error { indexed.Add(1); return nil }}),
	)
	result, err := service.Reopen(context.Background(), task.ID, ReopenOptions{Actor: "tester"})
	if err != nil {
		t.Fatalf("Reopen: %v", err)
	}
	if !result.Changed || indexed.Load() != 1 || result.After != models.TaskLifecycleActive {
		t.Fatalf("reopen result = %#v index=%d", result, indexed.Load())
	}
	loaded, err := store.Tasks.Get(task.ID)
	if err != nil {
		t.Fatalf("Get reopened: %v", err)
	}
	if loaded.Archived || loaded.Status != "todo" || loaded.CompletedAt != nil || loaded.ArchivedAt != nil {
		t.Fatalf("reopened Task = %#v", loaded)
	}
	historyBeforeRetry, _ := store.Versions.GetHistory(task.ID)
	retry, err := service.Unarchive(context.Background(), task.ID, ReopenOptions{})
	if err != nil || retry.Changed {
		t.Fatalf("idempotent retry = %#v, %v", retry, err)
	}
	historyAfterRetry, _ := store.Versions.GetHistory(task.ID)
	if len(historyAfterRetry.Versions) != len(historyBeforeRetry.Versions) || indexed.Load() != 2 {
		t.Fatalf("retry changed history/index: before=%d after=%d index=%d", len(historyBeforeRetry.Versions), len(historyAfterRetry.Versions), indexed.Load())
	}
}

func TestBatchArchivePreviewsByDefaultAndExecutesExplicitly(t *testing.T) {
	store := newLifecycleStore(t)
	eligible := lifecycleTask("batch1", "done", "")
	eligible.CompletedAt = timePointer(fixedNow.Add(-time.Hour))
	ineligible := lifecycleTask("batch2", "in-progress", "")
	createLifecycleTask(t, store, eligible)
	createLifecycleTask(t, store, ineligible)
	service := New(store, WithClock(func() time.Time { return fixedNow }))

	preview, err := service.BatchArchive(context.Background(), BatchOptions{})
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	if preview.Execute || preview.Changed != 0 || len(preview.Items) != 2 {
		t.Fatalf("preview = %#v", preview)
	}
	assertArchived(t, store, eligible.ID, false)

	executed, err := service.BatchArchive(context.Background(), BatchOptions{Execute: true})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !executed.Execute || executed.Changed != 1 {
		t.Fatalf("executed = %#v", executed)
	}
	assertArchived(t, store, eligible.ID, true)
}

func TestBatchArchiveReturnsPartialProgressAndRetryRepairsArchivedIndex(t *testing.T) {
	store := newLifecycleStore(t)
	for _, id := range []string{"batch-a", "batch-b", "batch-c"} {
		task := lifecycleTask(id, "done", "")
		task.CompletedAt = timePointer(fixedNow.Add(-time.Hour))
		createLifecycleTask(t, store, task)
	}

	var (
		failSecond atomic.Bool
		eventsMu   sync.Mutex
		events     []string
	)
	failSecond.Store(true)
	assertHookOutsideLock := func() error {
		ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
		defer cancel()
		return store.WithTaskLifecycleTransaction(ctx, func(*storage.TaskLifecycleTransaction) error { return nil })
	}
	service := New(store,
		WithClock(func() time.Time { return fixedNow }),
		WithHooks(Hooks{
			IndexTask: func(id string) error {
				if err := assertHookOutsideLock(); err != nil {
					return err
				}
				if id == "batch-b" && failSecond.Load() {
					return errors.New("index unavailable")
				}
				return nil
			},
			Emit: func(event Event) error {
				if err := assertHookOutsideLock(); err != nil {
					return err
				}
				eventsMu.Lock()
				events = append(events, event.TaskID)
				eventsMu.Unlock()
				return nil
			},
		}),
	)

	partial, err := service.BatchArchive(context.Background(), BatchOptions{Execute: true})
	if err == nil || !strings.Contains(err.Error(), "index unavailable") {
		t.Fatalf("BatchArchive error = %v", err)
	}
	if !partial.Completed || partial.Processed != 3 || partial.Changed != 3 || partial.FailedTaskID != "batch-b" || len(partial.Items) != 3 {
		t.Fatalf("partial batch = %#v", partial)
	}
	assertArchived(t, store, "batch-a", true)
	assertArchived(t, store, "batch-b", true)
	assertArchived(t, store, "batch-c", true)
	if !reflect.DeepEqual(events, []string{"batch-a", "batch-b", "batch-c"}) {
		t.Fatalf("events after partial batch = %v", events)
	}

	failSecond.Store(false)
	retry, err := service.AutoArchive(context.Background(), "sweeper")
	if err != nil {
		t.Fatalf("BatchArchive retry: %v", err)
	}
	if !retry.Completed || retry.Processed != 1 || retry.Changed != 0 || retry.FailedTaskID != "" {
		t.Fatalf("retry batch = %#v", retry)
	}
	assertArchived(t, store, "batch-b", true)
	assertArchived(t, store, "batch-c", true)
	if !reflect.DeepEqual(events, []string{"batch-a", "batch-b", "batch-c"}) {
		t.Fatalf("events after retry = %v", events)
	}
}

func TestLifecycleMutationRollsBackWhenHistoryWriteFailsAndRetryConverges(t *testing.T) {
	t.Run("archive", func(t *testing.T) {
		store := newLifecycleStore(t)
		task := lifecycleTask("histarc", "done", "")
		task.CompletedAt = timePointer(fixedNow.Add(-time.Hour))
		createLifecycleTask(t, store, task)
		historyPath := filepath.Join(store.Root, "versions", "task-"+task.ID+".json")
		if err := os.Mkdir(historyPath, 0o755); err != nil {
			t.Fatalf("inject history failure: %v", err)
		}

		var events atomic.Int32
		service := New(store,
			WithClock(func() time.Time { return fixedNow }),
			WithHooks(Hooks{Emit: func(Event) error { events.Add(1); return nil }}),
		)
		result, err := service.Archive(context.Background(), task.ID, ArchiveOptions{Actor: "tester"})
		if err == nil || result.Changed {
			t.Fatalf("Archive with history failure = %#v, %v", result, err)
		}
		assertArchived(t, store, task.ID, false)
		rolledBack, getErr := store.Tasks.Get(task.ID)
		if getErr != nil || rolledBack.ArchivedAt != nil || events.Load() != 0 {
			t.Fatalf("archive rollback Task=%#v getErr=%v events=%d", rolledBack, getErr, events.Load())
		}
		if err := os.Remove(historyPath); err != nil {
			t.Fatalf("remove failure injection: %v", err)
		}

		retry, err := service.Archive(context.Background(), task.ID, ArchiveOptions{Actor: "tester"})
		if err != nil || !retry.Changed || events.Load() != 1 {
			t.Fatalf("Archive retry = %#v, %v events=%d", retry, err, events.Load())
		}
		assertArchived(t, store, task.ID, true)
		history, err := store.Versions.GetHistory(task.ID)
		if err != nil || len(history.Versions) != 1 || !hasChange(history.Versions[0].Changes, "archived") {
			t.Fatalf("archive history after retry = %#v, %v", history, err)
		}
	})

	t.Run("reopen", func(t *testing.T) {
		store := newLifecycleStore(t)
		task := lifecycleTask("histopen", "done", "")
		task.CompletedAt = timePointer(fixedNow.Add(-time.Hour))
		createLifecycleTask(t, store, task)
		if _, err := New(store, WithClock(func() time.Time { return fixedNow })).Archive(context.Background(), task.ID, ArchiveOptions{}); err != nil {
			t.Fatalf("Archive: %v", err)
		}
		historyPath := filepath.Join(store.Root, "versions", "task-"+task.ID+".json")
		backupPath := historyPath + ".backup"
		if err := os.Rename(historyPath, backupPath); err != nil {
			t.Fatalf("backup history: %v", err)
		}
		if err := os.Mkdir(historyPath, 0o755); err != nil {
			t.Fatalf("inject history failure: %v", err)
		}

		var events atomic.Int32
		service := New(store,
			WithClock(func() time.Time { return fixedNow.Add(time.Minute) }),
			WithHooks(Hooks{Emit: func(Event) error { events.Add(1); return nil }}),
		)
		result, err := service.Reopen(context.Background(), task.ID, ReopenOptions{Actor: "tester"})
		if err == nil || result.Changed {
			t.Fatalf("Reopen with history failure = %#v, %v", result, err)
		}
		rolledBack, getErr := store.Tasks.Get(task.ID)
		if getErr != nil || !rolledBack.Archived || rolledBack.Status != "done" || rolledBack.CompletedAt == nil || rolledBack.ArchivedAt == nil || events.Load() != 0 {
			t.Fatalf("reopen rollback Task=%#v getErr=%v events=%d", rolledBack, getErr, events.Load())
		}
		if err := os.Remove(historyPath); err != nil {
			t.Fatalf("remove failure injection: %v", err)
		}
		if err := os.Rename(backupPath, historyPath); err != nil {
			t.Fatalf("restore history: %v", err)
		}

		retry, err := service.Reopen(context.Background(), task.ID, ReopenOptions{Actor: "tester"})
		if err != nil || !retry.Changed || events.Load() != 1 {
			t.Fatalf("Reopen retry = %#v, %v events=%d", retry, err, events.Load())
		}
		reopened, err := store.Tasks.Get(task.ID)
		if err != nil || reopened.Archived || reopened.Status != "todo" || reopened.CompletedAt != nil || reopened.ArchivedAt != nil {
			t.Fatalf("reopened Task = %#v, %v", reopened, err)
		}
		history, err := store.Versions.GetHistory(task.ID)
		if err != nil || len(history.Versions) != 2 || !hasChange(history.Versions[1].Changes, "archived") || !hasChange(history.Versions[1].Changes, "status") {
			t.Fatalf("reopen history after retry = %#v, %v", history, err)
		}
	})
}

func TestArchiveFailsClosedWhenTimerStateIsCorrupt(t *testing.T) {
	store := newLifecycleStore(t)
	task := lifecycleTask("badtime", "done", "")
	task.CompletedAt = timePointer(fixedNow.Add(-time.Hour))
	createLifecycleTask(t, store, task)
	if err := os.WriteFile(filepath.Join(store.Root, "time.json"), []byte("{"), 0o644); err != nil {
		t.Fatalf("corrupt time state: %v", err)
	}

	var indexed, events atomic.Int32
	service := New(store, WithHooks(Hooks{
		IndexTask: func(string) error { indexed.Add(1); return nil },
		Emit:      func(Event) error { events.Add(1); return nil },
	}))
	_, err := service.Archive(context.Background(), task.ID, ArchiveOptions{})
	if err == nil || !strings.Contains(err.Error(), "parse time.json") {
		t.Fatalf("Archive error = %v, want corrupt timer state", err)
	}
	assertArchived(t, store, task.ID, false)
	history, historyErr := store.Versions.GetHistory(task.ID)
	if historyErr != nil || len(history.Versions) != 0 || indexed.Load() != 0 || events.Load() != 0 {
		t.Fatalf("corrupt state mutation: history=%#v err=%v index=%d events=%d", history, historyErr, indexed.Load(), events.Load())
	}
}

func TestHardDeleteRequiresIntentPurgesDataAndRecoversTombstoneFirst(t *testing.T) {
	store := newLifecycleStore(t)
	task := lifecycleTask("gone01", "done", "")
	task.CompletedAt = timePointer(fixedNow.Add(-time.Hour))
	createLifecycleTask(t, store, task)
	if err := store.Versions.SaveVersion(task.ID, models.TaskVersion{Snapshot: storage.TaskToSnapshot(task)}); err != nil {
		t.Fatalf("seed history: %v", err)
	}
	if err := store.Time.Start(task.ID, task.Title); err != nil {
		t.Fatalf("start timer: %v", err)
	}
	if err := store.Time.SaveEntry(task.ID, models.TimeEntry{ID: "entry", StartedAt: fixedNow, Duration: 1}); err != nil {
		t.Fatalf("save entry: %v", err)
	}

	var removed atomic.Int32
	service := New(store,
		WithClock(func() time.Time { return fixedNow }),
		WithHooks(Hooks{RemoveTask: func(id string) error { removed.Add(1); return nil }}),
	)
	preview, err := service.HardDelete(context.Background(), task.ID, HardDeleteOptions{})
	if err != nil || preview.Changed || len(preview.Reasons) != 2 {
		t.Fatalf("hard-delete preview = %#v, %v", preview, err)
	}
	if _, err := store.Tasks.Get(task.ID); err != nil {
		t.Fatalf("preview mutated Task: %v", err)
	}

	result, err := service.HardDelete(context.Background(), task.ID, HardDeleteOptions{Confirmed: true, Reason: "privacy request", Actor: "tester"})
	if err != nil || !result.Changed || removed.Load() != 1 {
		t.Fatalf("HardDelete = %#v, %v remove=%d", result, err, removed.Load())
	}
	if _, err := store.Tasks.Get(task.ID); err == nil {
		t.Fatal("hard-deleted Task remains readable")
	}
	history, _ := store.Versions.GetHistory(task.ID)
	if len(history.Versions) != 0 {
		t.Fatalf("history retained: %#v", history)
	}
	if timer := store.Time.GetActiveTimer(task.ID); timer != nil {
		t.Fatalf("active timer retained: %#v", timer)
	}
	entries, _ := store.Time.GetEntries(task.ID)
	if len(entries) != 0 {
		t.Fatalf("time entries retained: %#v", entries)
	}
	if err := store.Versions.SaveVersion(task.ID, models.TaskVersion{Snapshot: map[string]any{"status": "done"}}); err == nil || !strings.Contains(err.Error(), "hard-deleted") {
		t.Fatalf("SaveVersion after hard-delete error = %v", err)
	}
	if err := store.Time.Start(task.ID, task.Title); err == nil || !strings.Contains(err.Error(), "hard-deleted") {
		t.Fatalf("Start after hard-delete error = %v", err)
	}
	if err := store.Time.SaveEntry(task.ID, models.TimeEntry{ID: "late", StartedAt: fixedNow}); err == nil || !strings.Contains(err.Error(), "hard-deleted") {
		t.Fatalf("SaveEntry after hard-delete error = %v", err)
	}
	tombstonePath := filepath.Join(store.Root, "tombstones", "tasks", task.ID+".json")
	data, err := os.ReadFile(tombstonePath)
	if err != nil {
		t.Fatalf("read tombstone: %v", err)
	}
	var fields map[string]any
	if err := json.Unmarshal(data, &fields); err != nil || len(fields) != 4 {
		t.Fatalf("tombstone fields = %#v, %v", fields, err)
	}

	retry, err := service.HardDelete(context.Background(), task.ID, HardDeleteOptions{Confirmed: true, Reason: "privacy request", Actor: "tester"})
	if err != nil || retry.Changed || removed.Load() != 2 {
		t.Fatalf("retry = %#v, %v remove=%d", retry, err, removed.Load())
	}

	partial := lifecycleTask("partial", "done", "")
	createLifecycleTask(t, store, partial)
	if err := store.Tasks.SaveTombstone(&models.TaskTombstone{ID: partial.ID, DeletedAt: fixedNow, Actor: "tester", Reason: "recover"}); err != nil {
		t.Fatalf("seed partial tombstone: %v", err)
	}
	recovered, err := service.HardDelete(context.Background(), partial.ID, HardDeleteOptions{Confirmed: true, Reason: "recover", Actor: "tester"})
	if err != nil || !recovered.Changed {
		t.Fatalf("recover partial hard-delete = %#v, %v", recovered, err)
	}
	if _, err := store.Tasks.Get(partial.ID); err == nil {
		t.Fatal("partial tombstone recovery left live Task")
	}
}

func TestHardDeleteRetryCompletesCleanupAndDoesNotRedeliverEvent(t *testing.T) {
	store := newLifecycleStore(t)
	task := lifecycleTask("delete-retry", "done", "")
	createLifecycleTask(t, store, task)

	// A non-empty directory at the history-file path makes cleanup fail only
	// after the immutable tombstone and canonical Task deletion have completed.
	historyPath := filepath.Join(store.Root, "versions", "task-"+task.ID+".json")
	if err := os.MkdirAll(historyPath, 0o755); err != nil {
		t.Fatalf("inject history cleanup failure: %v", err)
	}
	markerPath := filepath.Join(historyPath, "marker")
	if err := os.WriteFile(markerPath, []byte("fail cleanup"), 0o644); err != nil {
		t.Fatalf("write cleanup marker: %v", err)
	}

	var events atomic.Int32
	var removeAttempts atomic.Int32
	service := New(store,
		WithClock(func() time.Time { return fixedNow }),
		WithHooks(Hooks{
			Emit: func(event Event) error {
				if event.ID == "" {
					return errors.New("missing stable event ID")
				}
				events.Add(1)
				return nil
			},
			RemoveTask: func(string) error {
				if removeAttempts.Add(1) == 1 {
					return errors.New("index unavailable")
				}
				return nil
			},
		}))
	options := HardDeleteOptions{Confirmed: true, Reason: "privacy request", Actor: "tester"}

	first, err := service.HardDelete(context.Background(), task.ID, options)
	if err == nil || !strings.Contains(err.Error(), "delete task version history") || !first.Changed {
		t.Fatalf("first HardDelete = %#v, %v", first, err)
	}
	if events.Load() != 0 || removeAttempts.Load() != 0 {
		t.Fatalf("side effects ran before canonical cleanup: events=%d remove=%d", events.Load(), removeAttempts.Load())
	}
	if _, err := store.Tasks.Get(task.ID); err == nil {
		t.Fatal("Task remains after tombstone-first partial delete")
	}
	if got := pendingLifecycleRecords(t, store, string(OperationHardDelete)); len(got) != 1 || got[0].CanonicalComplete {
		t.Fatalf("pending after cleanup failure = %#v", got)
	}
	if err := os.Remove(markerPath); err != nil {
		t.Fatalf("remove cleanup marker: %v", err)
	}
	if err := os.Remove(historyPath); err != nil {
		t.Fatalf("remove injected history directory: %v", err)
	}

	second, err := service.HardDelete(context.Background(), task.ID, options)
	if err == nil || !strings.Contains(err.Error(), "index unavailable") || second.Changed {
		t.Fatalf("second HardDelete = %#v, %v", second, err)
	}
	if events.Load() != 1 || removeAttempts.Load() != 1 {
		t.Fatalf("post-cleanup side effects: events=%d remove=%d", events.Load(), removeAttempts.Load())
	}
	if got := pendingLifecycleRecords(t, store, string(OperationHardDelete)); len(got) != 1 || !got[0].CanonicalComplete || !got[0].EventDelivered || got[0].DerivedApplied {
		t.Fatalf("pending after RemoveTask failure = %#v", got)
	}

	third, err := service.HardDelete(context.Background(), task.ID, options)
	if err != nil || third.Changed {
		t.Fatalf("third HardDelete = %#v, %v", third, err)
	}
	if events.Load() != 1 || removeAttempts.Load() != 2 {
		t.Fatalf("retry duplicated side effects: events=%d remove=%d", events.Load(), removeAttempts.Load())
	}
	if got := pendingLifecycleRecords(t, store, string(OperationHardDelete)); len(got) != 0 {
		t.Fatalf("pending after completed retry = %#v", got)
	}
}

func TestConcurrentCreateAndHardDeleteNeverLeaveLiveTaskWithTombstone(t *testing.T) {
	storeA := newLifecycleStore(t)
	storeB := storage.NewStore(storeA.Root)
	task := lifecycleTask("race01", "done", "")
	createLifecycleTask(t, storeA, task)
	service := New(storeA, WithClock(func() time.Time { return fixedNow }))

	start := make(chan struct{})
	errCh := make(chan error, 2)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		<-start
		_, err := service.HardDelete(context.Background(), task.ID, HardDeleteOptions{Confirmed: true, Reason: "race", Actor: "tester"})
		errCh <- err
	}()
	go func() {
		defer wg.Done()
		<-start
		replacement := lifecycleTask(task.ID, "todo", "")
		errCh <- storeB.Tasks.Create(replacement)
	}()
	close(start)
	wg.Wait()
	close(errCh)

	deleteSucceeded := false
	for err := range errCh {
		if err == nil {
			deleteSucceeded = true
			continue
		}
		if !strings.Contains(err.Error(), "already exists") && !strings.Contains(err.Error(), "reserved") {
			t.Fatalf("concurrent operation error = %v", err)
		}
	}
	if !deleteSucceeded {
		t.Fatal("hard-delete did not succeed")
	}
	if _, err := storeA.Tasks.Get(task.ID); err == nil {
		t.Fatal("live Task remains beside tombstone")
	}
	if reserved, err := storeA.Tasks.IsIDReserved(task.ID); err != nil || !reserved {
		t.Fatalf("reserved = %v, %v", reserved, err)
	}
}

func TestConcurrentArchiveAndReopenConvergeToOneActiveCopy(t *testing.T) {
	store := newLifecycleStore(t)
	task := lifecycleTask("trans1", "done", "")
	task.CompletedAt = timePointer(fixedNow.Add(-time.Hour))
	createLifecycleTask(t, store, task)
	service := New(store, WithClock(func() time.Time { return fixedNow }))

	start := make(chan struct{})
	errCh := make(chan error, 2)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		<-start
		_, err := service.Archive(context.Background(), task.ID, ArchiveOptions{})
		errCh <- err
	}()
	go func() {
		defer wg.Done()
		<-start
		_, err := service.Reopen(context.Background(), task.ID, ReopenOptions{})
		errCh <- err
	}()
	close(start)
	wg.Wait()
	close(errCh)
	for err := range errCh {
		if err != nil {
			t.Fatalf("concurrent transition: %v", err)
		}
	}
	loaded, err := store.Tasks.Get(task.ID)
	if err != nil {
		t.Fatalf("Get converged Task: %v", err)
	}
	if loaded.Archived || loaded.Status != "todo" {
		t.Fatalf("final Task = %#v, want one active todo copy", loaded)
	}
	active, _ := store.Tasks.List()
	archived, _ := store.Tasks.ListArchived()
	if countID(active, task.ID) != 1 || countID(archived, task.ID) != 0 {
		t.Fatalf("copies active=%d archived=%d", countID(active, task.ID), countID(archived, task.ID))
	}
}

func TestConcurrentTimerStartAndArchiveNeverLeaveArchivedTaskWithActiveTimer(t *testing.T) {
	for attempt := 0; attempt < 20; attempt++ {
		store := newLifecycleStore(t)
		task := lifecycleTask("timerace", "done", "")
		task.CompletedAt = timePointer(fixedNow.Add(-time.Hour))
		createLifecycleTask(t, store, task)
		service := New(store, WithClock(func() time.Time { return fixedNow }))

		start := make(chan struct{})
		archiveErr := make(chan error, 1)
		timerErr := make(chan error, 1)
		go func() {
			<-start
			_, err := service.Archive(context.Background(), task.ID, ArchiveOptions{})
			archiveErr <- err
		}()
		go func() {
			<-start
			timerErr <- store.Time.Start(task.ID, task.Title)
		}()
		close(start)
		if err := <-archiveErr; err != nil {
			t.Fatalf("attempt %d archive: %v", attempt, err)
		}
		startErr := <-timerErr
		if startErr != nil && !strings.Contains(startErr.Error(), "archived Task") {
			t.Fatalf("attempt %d timer: %v", attempt, startErr)
		}

		loaded, err := store.Tasks.Get(task.ID)
		if err != nil {
			t.Fatalf("attempt %d Get: %v", attempt, err)
		}
		timer := store.Time.GetActiveTimer(task.ID)
		if loaded.Archived && timer != nil {
			t.Fatalf("attempt %d left archived Task with timer %#v", attempt, timer)
		}
		if !loaded.Archived && timer == nil {
			t.Fatalf("attempt %d skipped archive without retaining timer", attempt)
		}
	}
}

func TestIndexHookFailuresAreRecoverableByIdempotentRetry(t *testing.T) {
	t.Run("archive", func(t *testing.T) {
		store := newLifecycleStore(t)
		task := lifecycleTask("idxarc", "done", "")
		task.CompletedAt = timePointer(fixedNow.Add(-time.Hour))
		createLifecycleTask(t, store, task)
		var events atomic.Int32
		failing := New(store, WithHooks(Hooks{
			IndexTask: func(string) error { return errors.New("index down") },
			Emit:      func(Event) error { events.Add(1); return nil },
		}))
		first, err := failing.Archive(context.Background(), task.ID, ArchiveOptions{})
		if err == nil || !first.Changed || events.Load() != 1 {
			t.Fatalf("first Archive = %#v, %v", first, err)
		}

		var indexed atomic.Int32
		retrying := New(store, WithHooks(Hooks{
			IndexTask: func(string) error { indexed.Add(1); return nil },
			Emit:      func(Event) error { events.Add(1); return nil },
		}))
		second, err := retrying.Archive(context.Background(), task.ID, ArchiveOptions{})
		if err != nil || second.Changed || indexed.Load() != 1 || events.Load() != 1 {
			t.Fatalf("retry Archive = %#v, %v index=%d", second, err, indexed.Load())
		}
	})

	t.Run("reopen", func(t *testing.T) {
		store := newLifecycleStore(t)
		task := lifecycleTask("idxopen", "done", "")
		task.CompletedAt = timePointer(fixedNow.Add(-time.Hour))
		createLifecycleTask(t, store, task)
		if _, err := New(store).Archive(context.Background(), task.ID, ArchiveOptions{}); err != nil {
			t.Fatalf("Archive: %v", err)
		}
		var events atomic.Int32
		failing := New(store, WithHooks(Hooks{
			IndexTask: func(string) error { return errors.New("index down") },
			Emit:      func(Event) error { events.Add(1); return nil },
		}))
		first, err := failing.Reopen(context.Background(), task.ID, ReopenOptions{})
		if err == nil || !first.Changed || events.Load() != 1 {
			t.Fatalf("first Reopen = %#v, %v", first, err)
		}

		var indexed atomic.Int32
		retrying := New(store, WithHooks(Hooks{
			IndexTask: func(string) error { indexed.Add(1); return nil },
			Emit:      func(Event) error { events.Add(1); return nil },
		}))
		second, err := retrying.Reopen(context.Background(), task.ID, ReopenOptions{})
		if err != nil || second.Changed || indexed.Load() != 1 || events.Load() != 1 {
			t.Fatalf("retry Reopen = %#v, %v index=%d", second, err, indexed.Load())
		}
	})

	t.Run("hard-delete", func(t *testing.T) {
		store := newLifecycleStore(t)
		task := lifecycleTask("idxdel", "done", "")
		createLifecycleTask(t, store, task)
		var events atomic.Int32
		failing := New(store, WithClock(func() time.Time { return fixedNow }), WithHooks(Hooks{
			RemoveTask: func(string) error { return errors.New("index down") },
			Emit:       func(Event) error { events.Add(1); return nil },
		}))
		options := HardDeleteOptions{Confirmed: true, Reason: "review test", Actor: "tester"}
		first, err := failing.HardDelete(context.Background(), task.ID, options)
		if err == nil || !first.Changed || events.Load() != 1 {
			t.Fatalf("first HardDelete = %#v, %v events=%d", first, err, events.Load())
		}

		var removed atomic.Int32
		retrying := New(store, WithHooks(Hooks{
			RemoveTask: func(string) error { removed.Add(1); return nil },
			Emit:       func(Event) error { events.Add(1); return nil },
		}))
		second, err := retrying.HardDelete(context.Background(), task.ID, options)
		if err != nil || second.Changed || removed.Load() != 1 || events.Load() != 1 {
			t.Fatalf("retry HardDelete = %#v, %v removed=%d events=%d", second, err, removed.Load(), events.Load())
		}
	})
}

func TestCanceledLifecycleOperationDoesNotMutate(t *testing.T) {
	store := newLifecycleStore(t)
	task := lifecycleTask("cancel", "done", "")
	task.CompletedAt = timePointer(fixedNow.Add(-time.Hour))
	createLifecycleTask(t, store, task)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := New(store).Archive(ctx, task.ID, ArchiveOptions{})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Archive error = %v, want context canceled", err)
	}
	assertArchived(t, store, task.ID, false)
}

func TestEventDeliveryFailureIsNonBlockingWarning(t *testing.T) {
	store := newLifecycleStore(t)
	task := lifecycleTask("event1", "done", "")
	task.CompletedAt = timePointer(fixedNow.Add(-time.Hour))
	createLifecycleTask(t, store, task)
	service := New(store, WithHooks(Hooks{Emit: func(Event) error { return errors.New("sink unavailable") }}))
	result, err := service.Archive(context.Background(), task.ID, ArchiveOptions{})
	if err != nil {
		t.Fatalf("Archive: %v", err)
	}
	if len(result.Warnings) != 1 || result.Warnings[0].Code != WarningEventDeliveryError {
		t.Fatalf("warnings = %#v", result.Warnings)
	}
	assertArchived(t, store, task.ID, true)
}

func newLifecycleStore(t *testing.T) *storage.Store {
	t.Helper()
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("lifecycle-test"); err != nil {
		t.Fatalf("Init: %v", err)
	}
	return store
}

func lifecycleTask(id, status, parent string) *models.Task {
	return &models.Task{
		ID:        id,
		Title:     "Task " + id,
		Status:    status,
		Priority:  "medium",
		Parent:    parent,
		CreatedAt: fixedNow.Add(-40 * 24 * time.Hour),
		UpdatedAt: fixedNow.Add(-time.Hour),
	}
}

func createLifecycleTask(t *testing.T, store *storage.Store, task *models.Task) {
	t.Helper()
	if err := store.Tasks.Create(task); err != nil {
		t.Fatalf("Create %s: %v", task.ID, err)
	}
}

func setLifecycleSettings(t *testing.T, store *storage.Store, settings models.TaskLifecycleSettings) {
	t.Helper()
	project, err := store.Config.Load()
	if err != nil {
		t.Fatalf("Load config: %v", err)
	}
	project.Settings.TaskLifecycle = &settings
	if err := store.Config.Save(project); err != nil {
		t.Fatalf("Save config: %v", err)
	}
}

func assertArchived(t *testing.T, store *storage.Store, taskID string, want bool) {
	t.Helper()
	task, err := store.Tasks.Get(taskID)
	if err != nil {
		t.Fatalf("Get %s: %v", taskID, err)
	}
	if task.Archived != want {
		t.Fatalf("Task %s archived = %v, want %v", taskID, task.Archived, want)
	}
}

func reasonCodes(reasons []Reason) []ReasonCode {
	result := make([]ReasonCode, len(reasons))
	for index := range reasons {
		result[index] = reasons[index].Code
	}
	return result
}

func hasChange(changes []models.TaskChange, field string) bool {
	for _, change := range changes {
		if change.Field == field {
			return true
		}
	}
	return false
}

func countID(tasks []*models.Task, id string) int {
	count := 0
	for _, task := range tasks {
		if task.ID == id {
			count++
		}
	}
	return count
}

func taskFilePath(t *testing.T, root, directory, id string) string {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(root, directory, "task-"+id+"*.md"))
	if err != nil || len(matches) != 1 {
		t.Fatalf("find Task %s in %s: matches=%v err=%v", id, directory, matches, err)
	}
	return matches[0]
}

func pendingLifecycleRecords(t *testing.T, store *storage.Store, operation string) []*models.TaskLifecyclePending {
	t.Helper()
	var records []*models.TaskLifecyclePending
	err := store.WithTaskLifecycleTransaction(context.Background(), func(tx *storage.TaskLifecycleTransaction) error {
		var err error
		records, err = tx.ListTaskLifecyclePending(operation)
		return err
	})
	if err != nil {
		t.Fatalf("list pending lifecycle records: %v", err)
	}
	return records
}

func assertCRLFRawExtensions(t *testing.T, path, unknown, customBody string) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read CRLF Task: %v", err)
	}
	content := string(raw)
	if !strings.Contains(content, unknown) || !strings.HasSuffix(content, customBody) {
		t.Fatalf("lifecycle mutation discarded CRLF extension:\n%s", content)
	}
	if strings.Contains(strings.ReplaceAll(content, "\r\n", ""), "\n") {
		t.Fatalf("lifecycle mutation introduced bare LF into CRLF Task:\n%q", content)
	}
}

func seedInterruptedLifecycleBoundary(t *testing.T, store *storage.Store, pending *models.TaskLifecyclePending, original, desired *models.Task, boundary string) {
	t.Helper()
	err := store.WithTaskLifecycleTransaction(context.Background(), func(tx *storage.TaskLifecycleTransaction) error {
		if err := tx.SaveTaskLifecyclePending(pending); err != nil {
			return err
		}
		if boundary == "pending_to_move" {
			return nil
		}
		if original.Archived != desired.Archived {
			if desired.Archived {
				if err := tx.ArchiveTask(original.ID); err != nil {
					return err
				}
			} else if err := tx.UnarchiveTask(original.ID); err != nil {
				return err
			}
		}
		// Simulate death after the move itself but before MoveComplete is saved.
		if boundary == "move_to_patch" {
			return nil
		}
		pending.MoveComplete = true
		if err := tx.SaveTaskLifecyclePending(pending); err != nil {
			return err
		}
		if err := tx.PatchTaskLifecycle(desired); err != nil {
			return err
		}
		// Simulate death after raw frontmatter patch but before its checkpoint.
		if boundary == "patch_to_version" {
			return nil
		}
		pending.PatchComplete = true
		if err := tx.SaveTaskLifecyclePending(pending); err != nil {
			return err
		}
		if err := tx.SaveTaskVersion(original, desired, pending.Actor, pending.At, pending.EventID); err != nil {
			return err
		}
		// Stable LifecycleEventID must prevent a duplicate append from here.
		if boundary == "version_to_canonical" {
			return nil
		}
		pending.VersionComplete = true
		pending.CanonicalComplete = true
		if err := tx.SaveTaskLifecyclePending(pending); err != nil {
			return err
		}
		if boundary == "canonical_to_event" {
			return nil
		}
		pending.EventDelivered = true
		return tx.SaveTaskLifecyclePending(pending)
	})
	if err != nil {
		t.Fatalf("seed interrupted lifecycle boundary %s: %v", boundary, err)
	}
}

func seedCanonicalArchivePending(t *testing.T, id string) (*storage.Store, *models.Task, *models.TaskLifecyclePending) {
	t.Helper()
	store := newLifecycleStore(t)
	task := lifecycleTask(id, "done", "")
	task.CompletedAt = timePointer(fixedNow.Add(-time.Hour))
	createLifecycleTask(t, store, task)
	original, err := store.Tasks.Get(task.ID)
	if err != nil {
		t.Fatalf("get canonical seed Task: %v", err)
	}
	desired := cloneTask(original)
	desired.Archived = true
	desired.ArchivedAt = timePointer(fixedNow)
	desired.UpdatedAt = fixedNow
	event := Event{ID: "event-" + id, Type: OperationArchive, TaskID: id, At: fixedNow, From: models.TaskLifecycleDone, To: models.TaskLifecycleArchived}
	pending := pendingForTransition(event, original, desired)
	seedInterruptedLifecycleBoundary(t, store, pending, original, desired, "canonical_to_event")
	loaded, err := store.Tasks.Get(id)
	if err != nil {
		t.Fatalf("get canonical pending Task: %v", err)
	}
	return store, loaded, pending
}

func savePendingLifecycleRecord(t *testing.T, store *storage.Store, pending *models.TaskLifecyclePending) {
	t.Helper()
	if err := store.WithTaskLifecycleTransaction(context.Background(), func(tx *storage.TaskLifecycleTransaction) error {
		return tx.SaveTaskLifecyclePending(pending)
	}); err != nil {
		t.Fatalf("save pending lifecycle record: %v", err)
	}
}

func countLifecycleEvent(history *models.TaskVersionHistory, eventID string) int {
	if history == nil {
		return 0
	}
	count := 0
	for _, version := range history.Versions {
		if version.LifecycleEventID == eventID {
			count++
		}
	}
	return count
}
