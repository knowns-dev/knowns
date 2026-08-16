package tasklifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

func TestExecutePublicPreviewExecuteAndTrustedDeleteCapability(t *testing.T) {
	store := newPublicLifecycleStore(t)
	now := time.Date(2026, 7, 22, 1, 0, 0, 0, time.UTC)
	createPublicLifecycleTask(t, store, "public01", "done", now.Add(-time.Hour))
	service := New(store, WithClock(func() time.Time { return now }))

	preview, err := service.ExecutePublic(t.Context(), Request{Operation: OperationBatchArchive, IDs: []string{"public01"}}, false)
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	if !preview.Completed || preview.Execute || preview.Processed != 1 || preview.Changed != 0 || len(preview.Items) != 1 || !preview.Items[0].Eligible {
		t.Fatalf("preview = %+v", preview)
	}
	if task, err := store.Tasks.Get("public01"); err != nil || task.Archived {
		t.Fatalf("preview mutated Task: %+v, %v", task, err)
	}

	executed, err := service.ExecutePublic(t.Context(), Request{Operation: OperationBatchArchive, IDs: []string{"public01"}, Execute: true}, false)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !executed.Completed || executed.Changed != 1 || executed.Items[0].After != models.TaskLifecycleArchived || executed.Items[0].ArchivedAt == nil || executed.Items[0].Event == nil {
		t.Fatalf("execute = %+v", executed)
	}
	idempotent, err := service.ExecutePublic(t.Context(), Request{Operation: OperationBatchArchive, IDs: []string{"public01"}, Execute: true}, false)
	if err != nil {
		t.Fatalf("idempotent execute: %v", err)
	}
	if !idempotent.Completed || idempotent.Changed != 0 || len(idempotent.Items[0].Reasons) != 1 || idempotent.Items[0].Reasons[0].Code != ReasonAlreadyArchived {
		t.Fatalf("idempotent execute = %+v", idempotent)
	}

	denied, err := service.ExecutePublic(t.Context(), Request{Operation: OperationHardDelete, TaskID: "public01", Confirmed: true, Reason: "cleanup", Execute: true}, false)
	var contractErr *ContractError
	if !errors.As(err, &contractErr) || contractErr.Kind != FailurePermission {
		t.Fatalf("denied hard-delete error = %v", err)
	}
	if denied.Completed || len(denied.Items) != 1 || len(denied.Items[0].Reasons) != 1 || denied.Items[0].Reasons[0].Code != ReasonPermissionRequired {
		t.Fatalf("denied = %+v", denied)
	}
	if _, err := store.Tasks.Get("public01"); err != nil {
		t.Fatalf("denial removed Task: %v", err)
	}

	deleted, err := service.ExecutePublic(t.Context(), Request{Operation: OperationHardDelete, TaskID: "public01", Confirmed: true, Reason: "cleanup", Execute: true}, true)
	if err != nil {
		t.Fatalf("hard-delete: %v", err)
	}
	if !deleted.Completed || deleted.Changed != 1 || deleted.Items[0].Event == nil {
		t.Fatalf("deleted = %+v", deleted)
	}
	if _, err := store.Tasks.Get("public01"); err == nil {
		t.Fatal("hard-delete left Task content")
	}
	if tombstone, err := store.Tasks.GetTombstone("public01"); err != nil || tombstone.Reason != "cleanup" {
		t.Fatalf("tombstone = %+v, %v", tombstone, err)
	}

	missing, err := service.ExecutePublic(t.Context(), Request{Operation: OperationBatchArchive, IDs: []string{"missing"}}, false)
	if err == nil || missing.FailedTaskID != "missing" || len(missing.Items) != 1 || len(missing.Items[0].Reasons) != 1 || missing.Items[0].Reasons[0].Code != ReasonNotFound {
		t.Fatalf("missing = %+v, %v", missing, err)
	}
}

func TestPublicTaskHardDeletePurgesFilesystemLifecycleStateExactlyOnce(t *testing.T) {
	store := newPublicLifecycleStore(t)
	now := time.Date(2026, 7, 22, 1, 0, 0, 0, time.UTC)
	createPublicLifecycleTask(t, store, "public-fsr", "done", now.Add(-time.Hour))
	bootstrap, err := storage.NewFilesystemReconciler(store.Root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := bootstrap.ReconcileLifecycle(t.Context(), true); err != nil {
		t.Fatal(err)
	}
	var removes int
	service := New(store, WithClock(func() time.Time { return now }), WithHooks(Hooks{RemoveTask: func(string) error { removes++; return nil }}))
	result, err := service.HardDelete(t.Context(), "public-fsr", HardDeleteOptions{Confirmed: true, Reason: "privacy", Actor: "adapter"})
	if err != nil || !result.Changed || removes != 1 {
		t.Fatalf("hard-delete result=%+v err=%v removes=%d", result, err, removes)
	}
	if _, err := store.Tasks.Get("public-fsr"); err == nil {
		t.Fatal("Task canonical content remains")
	}
	if _, err := os.Stat(filepath.Join(store.Root, "history", "tasks", "public-fsr.jsonl")); !os.IsNotExist(err) {
		t.Fatalf("Task JSONL history remains: %v", err)
	}
	manifestData, err := os.ReadFile(filepath.Join(store.Root, "history", "state", "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Entries map[string]json.RawMessage `json:"entries"`
	}
	if err := json.Unmarshal(manifestData, &manifest); err != nil {
		t.Fatal(err)
	}
	if _, ok := manifest.Entries["task:public-fsr"]; ok {
		t.Fatal("Task manifest ownership remains after central purge")
	}
	intentPath := filepath.Join(store.Root, "history", "state", "lifecycle-intents.json")
	if data, readErr := os.ReadFile(intentPath); readErr == nil {
		var intents map[string]json.RawMessage
		if err := json.Unmarshal(data, &intents); err != nil {
			t.Fatal(err)
		}
		if len(intents) != 0 {
			t.Fatalf("stale lifecycle intents remain: %v", intents)
		}
	} else if !os.IsNotExist(readErr) {
		t.Fatal(readErr)
	}
	if _, err := bootstrap.ReconcileLifecycle(t.Context(), true); err != nil {
		t.Fatalf("post-purge watcher reconciliation: %v", err)
	}
	if removes != 1 {
		t.Fatalf("post-purge reconciliation redelivered remove: %d", removes)
	}
}

func TestExecutePublicCentralValidationAndFailureClassification(t *testing.T) {
	store := newPublicLifecycleStore(t)
	createPublicLifecycleTask(t, store, "contract-active", "todo", time.Time{})
	service := New(store)

	empty, err := service.ExecutePublic(t.Context(), Request{Operation: OperationBatchUnarchive}, false)
	assertContractFailure(t, empty, err, FailureInvalidRequest, ReasonInvalidRequest)

	preview, err := service.ExecutePublic(t.Context(), Request{Operation: OperationReopen, TaskID: "contract-active"}, false)
	if err != nil || len(preview.Items) != 1 || preview.Items[0].Eligible || preview.Items[0].Reasons[0].Code != ReasonAlreadyActive {
		t.Fatalf("active unarchive preview = %+v, %v", preview, err)
	}

	denied, err := service.ExecutePublic(t.Context(), Request{Operation: OperationArchive, TaskID: "contract-active", Execute: true}, false)
	assertContractFailure(t, denied, err, FailureDenied, ReasonNotDone)

	missingIntent, err := service.ExecutePublic(t.Context(), Request{Operation: OperationHardDelete, TaskID: "contract-active", Execute: true}, true)
	assertContractFailure(t, missingIntent, err, FailureInvalidRequest, ReasonConfirmationRequired)
	if len(missingIntent.Items[0].Reasons) != 2 || missingIntent.Items[0].Reasons[1].Code != ReasonDeleteReasonRequired {
		t.Fatalf("hard-delete reasons = %+v", missingIntent)
	}
}

func assertContractFailure(t *testing.T, response *Response, err error, wantKind FailureKind, wantReason ReasonCode) {
	t.Helper()
	var contractErr *ContractError
	if !errors.As(err, &contractErr) || contractErr.Kind != wantKind {
		t.Fatalf("contract error = %v, want %s", err, wantKind)
	}
	if response == nil || len(response.Items) == 0 || len(response.Items[0].Reasons) == 0 || response.Items[0].Reasons[0].Code != wantReason {
		t.Fatalf("contract response = %+v, want reason %s", response, wantReason)
	}
}

func TestUpdateTaskSerializesWithLifecycleTransitionsAndHooksOutsideLock(t *testing.T) {
	t.Run("status update then archive preserves completion and archive clocks", func(t *testing.T) {
		store := newPublicLifecycleStore(t)
		createPublicLifecycleTask(t, store, "race-archive", "todo", time.Time{})
		now := time.Date(2026, 7, 22, 2, 0, 0, 0, time.UTC)
		service := New(store, WithClock(func() time.Time { return now }))
		entered := make(chan struct{})
		release := make(chan struct{})
		updateDone := make(chan error, 1)
		go func() {
			_, err := service.UpdateTask(context.Background(), "race-archive", TaskUpdateOptions{Mutate: func(task *models.Task) error {
				close(entered)
				<-release
				task.Status = "done"
				return nil
			}})
			updateDone <- err
		}()
		<-entered
		archiveDone := make(chan error, 1)
		go func() {
			_, err := service.Archive(context.Background(), "race-archive", ArchiveOptions{})
			archiveDone <- err
		}()
		close(release)
		if err := <-updateDone; err != nil {
			t.Fatalf("update: %v", err)
		}
		if err := <-archiveDone; err != nil {
			t.Fatalf("archive: %v", err)
		}
		task, err := store.Tasks.Get("race-archive")
		if err != nil || !task.Archived || task.CompletedAt == nil || task.ArchivedAt == nil {
			t.Fatalf("final Task = %+v, %v", task, err)
		}
	})

	t.Run("reopen hook does not hold lock and update uses reopened canonical task", func(t *testing.T) {
		store := newPublicLifecycleStore(t)
		createPublicLifecycleTask(t, store, "race-reopen", "done", time.Now().Add(-time.Hour))
		if _, err := New(store).Archive(t.Context(), "race-reopen", ArchiveOptions{}); err != nil {
			t.Fatal(err)
		}
		entered := make(chan struct{})
		release := make(chan struct{})
		service := New(store, WithHooks(Hooks{Emit: func(event Event) error {
			if event.Type == OperationReopen {
				close(entered)
				<-release
			}
			return nil
		}}))
		reopenDone := make(chan error, 1)
		go func() {
			_, err := service.Reopen(context.Background(), "race-reopen", ReopenOptions{})
			reopenDone <- err
		}()
		<-entered
		updateDone := make(chan error, 1)
		go func() {
			_, err := service.UpdateTask(context.Background(), "race-reopen", TaskUpdateOptions{Mutate: func(task *models.Task) error { task.Title = "fresh"; return nil }})
			updateDone <- err
		}()
		select {
		case err := <-updateDone:
			if err != nil {
				t.Fatalf("update while Emit blocked: %v", err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("update blocked behind external Emit hook")
		}
		close(release)
		if err := <-reopenDone; err != nil {
			t.Fatal(err)
		}
		task, err := store.Tasks.Get("race-reopen")
		if err != nil || task.Archived || task.Status != "todo" || task.CompletedAt != nil || task.ArchivedAt != nil || task.Title != "fresh" {
			t.Fatalf("final Task = %+v, %v", task, err)
		}
	})

	t.Run("hard-delete hook does not hold lock and stale update cannot resurrect", func(t *testing.T) {
		store := newPublicLifecycleStore(t)
		createPublicLifecycleTask(t, store, "race-delete", "todo", time.Time{})
		entered := make(chan struct{})
		release := make(chan struct{})
		service := New(store, WithHooks(Hooks{Emit: func(event Event) error {
			if event.Type == OperationHardDelete {
				close(entered)
				<-release
			}
			return nil
		}}))
		deleteDone := make(chan error, 1)
		go func() {
			_, err := service.HardDelete(context.Background(), "race-delete", HardDeleteOptions{Confirmed: true, Reason: "race"})
			deleteDone <- err
		}()
		<-entered
		updateDone := make(chan error, 1)
		go func() {
			_, err := service.UpdateTask(context.Background(), "race-delete", TaskUpdateOptions{Mutate: func(task *models.Task) error { task.Title = "stale"; return nil }})
			updateDone <- err
		}()
		select {
		case err := <-updateDone:
			if err == nil {
				t.Fatal("stale update unexpectedly succeeded")
			}
		case <-time.After(2 * time.Second):
			t.Fatal("update blocked behind external Emit hook")
		}
		close(release)
		if err := <-deleteDone; err != nil {
			t.Fatal(err)
		}
		if _, err := store.Tasks.Get("race-delete"); err == nil {
			t.Fatal("stale update resurrected Task")
		}
		if _, err := store.Tasks.GetTombstone("race-delete"); err != nil {
			t.Fatalf("missing tombstone: %v", err)
		}
	})
}

func TestUpdateTaskConcurrentSameBaseHasOnePublicWinner(t *testing.T) {
	store := newPublicLifecycleStore(t)
	createPublicLifecycleTask(t, store, "same-base", "todo", time.Time{})
	base, err := store.Tasks.Get("same-base")
	if err != nil {
		t.Fatal(err)
	}
	historyBefore, err := store.Versions.GetHistory(base.ID)
	if err != nil {
		t.Fatal(err)
	}

	var indexCalls atomic.Int32
	newSession := func() *Service {
		return New(store, WithHooks(Hooks{IndexTask: func(id string) error {
			if id != base.ID {
				return errors.New("unexpected Task index hook")
			}
			indexCalls.Add(1)
			return nil
		}}))
	}
	sessions := []*Service{newSession(), newSession()}
	ready := make(chan struct{}, 2)
	start := make(chan struct{})
	type outcome struct {
		updated *models.Task
		err     error
	}
	outcomes := make(chan outcome, 2)
	var workers sync.WaitGroup
	for index, title := range []string{"winner-a-secret", "winner-b-secret"} {
		workers.Add(1)
		go func(service *Service, title string) {
			defer workers.Done()
			ready <- struct{}{}
			<-start
			updated, updateErr := service.UpdateTask(context.Background(), base.ID, TaskUpdateOptions{
				ExpectedHash: base.CanonicalHash,
				Mutate: func(task *models.Task) error {
					task.Title = title
					return nil
				},
			})
			outcomes <- outcome{updated: updated, err: updateErr}
		}(sessions[index], title)
	}
	<-ready
	<-ready
	close(start)
	workers.Wait()
	close(outcomes)

	var winner *models.Task
	var loser error
	for result := range outcomes {
		if result.err == nil {
			if winner != nil {
				t.Fatal("both same-base updates succeeded")
			}
			winner = result.updated
			continue
		}
		if loser != nil {
			t.Fatalf("both same-base updates failed: %v and %v", loser, result.err)
		}
		loser = result.err
	}
	if winner == nil || loser == nil {
		t.Fatalf("same-base outcomes winner=%#v loser=%v", winner, loser)
	}
	if !errors.Is(loser, storage.ErrHistoryConflict) {
		t.Fatalf("loser error = %v, want ErrHistoryConflict", loser)
	}
	if strings.Contains(loser.Error(), "winner-") {
		t.Fatalf("loser error leaked Task content: %v", loser)
	}
	if indexCalls.Load() != 1 {
		t.Fatalf("index hooks = %d, want exactly one", indexCalls.Load())
	}

	final, err := store.Tasks.Get(base.ID)
	if err != nil {
		t.Fatal(err)
	}
	if final.Title != winner.Title || final.CanonicalHash == base.CanonicalHash || final.CanonicalHash != winner.CanonicalHash {
		t.Fatalf("final Task=%#v winner=%#v baseHash=%s", final, winner, base.CanonicalHash)
	}
	historyAfter, err := store.Versions.GetHistory(base.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(historyAfter.Versions) != len(historyBefore.Versions)+1 {
		t.Fatalf("history revisions before=%d after=%d", len(historyBefore.Versions), len(historyAfter.Versions))
	}
	if got := storage.CanonicalTaskHash(final); got != final.CanonicalHash {
		t.Fatalf("canonical hash=%s recomputed=%s", final.CanonicalHash, got)
	}
}

func newPublicLifecycleStore(t *testing.T) *storage.Store {
	t.Helper()
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("test"); err != nil {
		t.Fatal(err)
	}
	return store
}

func createPublicLifecycleTask(t *testing.T, store *storage.Store, id, status string, completedAt time.Time) {
	t.Helper()
	now := time.Now().UTC()
	task := &models.Task{ID: id, Title: id, Status: status, Priority: "medium", CreatedAt: now, UpdatedAt: now}
	if !completedAt.IsZero() {
		value := completedAt.UTC()
		task.CompletedAt = &value
	}
	if err := store.Tasks.Create(task); err != nil {
		t.Fatal(err)
	}
}
