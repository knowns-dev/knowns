package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/howznguyen/knowns/internal/tasklifecycle"
)

func TestTaskLifecycleRoutesPreviewExecuteSSEAndHardDeleteCapability(t *testing.T) {
	store := newTaskLifecycleRouteStore(t)
	createTaskLifecycleRouteTask(t, store, "route01")
	broadcaster := &fakeBroadcaster{}
	router := chi.NewRouter()
	(&TaskRoutes{store: store, sse: broadcaster}).Register(router)

	preview := callTaskLifecycleRoute(t, router, "/tasks/batch-archive", map[string]any{"ids": []string{"route01"}})
	if preview.Execute || !preview.Completed || preview.Processed != 1 || preview.Changed != 0 || !preview.Items[0].Eligible {
		t.Fatalf("preview = %+v", preview)
	}
	if task, err := store.Tasks.Get("route01"); err != nil || task.Archived {
		t.Fatalf("preview mutated: %+v, %v", task, err)
	}

	executed := callTaskLifecycleRoute(t, router, "/tasks/batch-archive", map[string]any{"ids": []string{"route01"}, "execute": true})
	if !executed.Execute || executed.Changed != 1 || executed.Items[0].After != models.TaskLifecycleArchived || executed.Items[0].Event == nil {
		t.Fatalf("execute = %+v", executed)
	}
	if len(broadcaster.events) == 0 || broadcaster.events[len(broadcaster.events)-1].Type != "tasks:lifecycle" {
		t.Fatalf("SSE events = %+v", broadcaster.events)
	}
	event, ok := broadcaster.events[len(broadcaster.events)-1].Data.(tasklifecycle.Event)
	if !ok || event.ID == "" || event.ID != executed.Items[0].Event.ID {
		t.Fatalf("SSE event = %#v, response event = %#v", broadcaster.events[len(broadcaster.events)-1].Data, executed.Items[0].Event)
	}
	idempotent := callTaskLifecycleRoute(t, router, "/tasks/batch-archive", map[string]any{"ids": []string{"route01"}, "execute": true})
	if !idempotent.Completed || idempotent.Changed != 0 || len(idempotent.Items[0].Reasons) != 1 || idempotent.Items[0].Reasons[0].Code != tasklifecycle.ReasonAlreadyArchived {
		t.Fatalf("idempotent archive = %+v", idempotent)
	}

	unarchivePreview := callTaskLifecycleRoute(t, router, "/tasks/route01/unarchive", map[string]any{})
	if unarchivePreview.Execute || unarchivePreview.Changed != 0 || unarchivePreview.Items[0].Before != models.TaskLifecycleArchived {
		t.Fatalf("unarchive preview = %+v", unarchivePreview)
	}
	unarchived := callTaskLifecycleRoute(t, router, "/tasks/route01/unarchive", map[string]any{"execute": true})
	if unarchived.Changed != 1 || unarchived.Items[0].After != models.TaskLifecycleActive {
		t.Fatalf("unarchive = %+v", unarchived)
	}
	alreadyActive := callTaskLifecycleRoute(t, router, "/tasks/route01/unarchive", map[string]any{})
	if alreadyActive.Items[0].Eligible || alreadyActive.Items[0].Reasons[0].Code != tasklifecycle.ReasonAlreadyActive {
		t.Fatalf("active unarchive preview = %+v", alreadyActive)
	}
	emptyStatus, empty := callTaskLifecycleRouteAny(t, router, "/tasks/batch-unarchive", map[string]any{})
	if emptyStatus != http.StatusBadRequest || empty.Items[0].Reasons[0].Code != tasklifecycle.ReasonInvalidRequest {
		t.Fatalf("empty batch-unarchive status=%d response=%+v", emptyStatus, empty)
	}

	// Request-controlled headers/body cannot grant the constructor capability.
	body := bytes.NewBufferString(`{"confirmed":true,"reason":"spoof"}`)
	req := httptest.NewRequest(http.MethodPost, "/tasks/route01/hard-delete", body)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Knowns-Capability", "task:hard-delete")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("spoofed capability status = %d, body=%s", w.Code, w.Body.String())
	}
	if _, err := store.Tasks.Get("route01"); err != nil {
		t.Fatalf("spoof deleted Task: %v", err)
	}

	allowedRouter := chi.NewRouter()
	(&TaskRoutes{store: store, sse: broadcaster, capabilities: TaskRouteCapabilities{HardDelete: true}}).Register(allowedRouter)
	w = httptest.NewRecorder()
	allowedRouter.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/tasks/route01/hard-delete", bytes.NewBufferString(`{}`)))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("missing intent status = %d, body=%s", w.Code, w.Body.String())
	}
	var missingIntent tasklifecycle.Response
	if err := json.Unmarshal(w.Body.Bytes(), &missingIntent); err != nil || missingIntent.Items[0].Reasons[0].Code != tasklifecycle.ReasonConfirmationRequired {
		t.Fatalf("missing intent response = %+v, %v", missingIntent, err)
	}

	deleted := callTaskLifecycleRoute(t, allowedRouter, "/tasks/route01/hard-delete", map[string]any{"confirmed": true, "reason": "approved cleanup"})
	if !deleted.Completed || deleted.Changed != 1 || deleted.Items[0].Operation != tasklifecycle.OperationHardDelete {
		t.Fatalf("delete = %+v", deleted)
	}
	if _, err := store.Tasks.Get("route01"); err == nil {
		t.Fatal("hard-delete left content")
	}
	if tombstone, err := store.Tasks.GetTombstone("route01"); err != nil || tombstone.Reason != "approved cleanup" {
		t.Fatalf("tombstone = %+v, %v", tombstone, err)
	}
	conflictStatus, conflict := callTaskLifecycleRouteAny(t, allowedRouter, "/tasks/route01/hard-delete", map[string]any{"confirmed": true, "reason": "different cleanup"})
	if conflictStatus != http.StatusConflict || conflict.Items[0].Reasons[0].Code != tasklifecycle.ReasonTombstoneConflict {
		t.Fatalf("tombstone conflict status=%d response=%+v", conflictStatus, conflict)
	}
}

func TestTaskAutoArchiveSweeperRunsBoundedStartupSweepWithoutPurge(t *testing.T) {
	store := newTaskLifecycleRouteStore(t)
	now := time.Now().UTC()
	completed := now.Add(-31 * 24 * time.Hour)
	if err := store.Tasks.Create(&models.Task{ID: "sweep01", Title: "sweep01", Status: "done", Priority: "medium", CreatedAt: completed.Add(-time.Hour), UpdatedAt: completed, CompletedAt: &completed}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	StartTaskAutoArchiveSweeper(ctx, func() *storage.Store { return store }, nil, time.Hour)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		task, err := store.Tasks.Get("sweep01")
		if err == nil && task.Archived {
			if _, err := store.Tasks.GetTombstone("sweep01"); err == nil {
				t.Fatal("auto-archive unexpectedly purged Task")
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("startup auto-archive sweep did not archive eligible Task")
}

func TestTaskAutoArchiveSweeperReportsPartialDerivedFailureAndRetries(t *testing.T) {
	store := newTaskLifecycleRouteStore(t)
	project, err := store.Config.Load()
	if err != nil {
		t.Fatal(err)
	}
	project.Settings.SemanticSearch = &models.SemanticSearchSettings{
		Enabled:  true,
		Provider: "api",
		Model:    "missing-lifecycle-test-model",
	}
	if err := store.Config.Save(project); err != nil {
		t.Fatal(err)
	}

	now := time.Now().UTC()
	completed := now.Add(-31 * 24 * time.Hour)
	for _, id := range []string{"sweep-partial-a", "sweep-partial-b"} {
		if err := store.Tasks.Create(&models.Task{ID: id, Title: id, Status: "done", Priority: "medium", CreatedAt: completed.Add(-time.Hour), UpdatedAt: completed, CompletedAt: &completed}); err != nil {
			t.Fatal(err)
		}
	}

	broadcaster := &lifecycleSweepBroadcaster{events: make(chan SSEEvent, 32)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	StartTaskAutoArchiveSweeper(ctx, func() *storage.Store { return store }, broadcaster, 25*time.Millisecond)

	first, firstLifecycleEvents := waitLifecycleSweepEvents(t, broadcaster.events)
	firstData, ok := first.Data.(map[string]any)
	if !ok {
		t.Fatalf("first sweep data = %#v", first.Data)
	}
	firstResult, ok := firstData["result"].(*tasklifecycle.BatchResult)
	if !ok || firstResult.Processed != 2 || firstResult.Changed != 2 || firstResult.FailedTaskID == "" || firstData["error"] == "" {
		t.Fatalf("first partial sweep = %#v", firstData)
	}
	expectedTaskIDs := []string{"sweep-partial-a", "sweep-partial-b"}
	if len(firstLifecycleEvents) != len(expectedTaskIDs) {
		t.Fatalf("first sweep lifecycle event count = %d, want %d: %+v", len(firstLifecycleEvents), len(expectedTaskIDs), firstLifecycleEvents)
	}
	eventsByTask := make(map[string]tasklifecycle.Event, len(firstLifecycleEvents))
	eventIDs := make(map[string]string, len(firstLifecycleEvents))
	for _, event := range firstLifecycleEvents {
		if event.ID == "" {
			t.Fatalf("first sweep lifecycle event has empty ID: %+v", event)
		}
		if priorTaskID, duplicate := eventIDs[event.ID]; duplicate {
			t.Fatalf("first sweep lifecycle event ID %q reused by Tasks %q and %q", event.ID, priorTaskID, event.TaskID)
		}
		if _, duplicate := eventsByTask[event.TaskID]; duplicate {
			t.Fatalf("first sweep emitted more than one lifecycle event for Task %q: %+v", event.TaskID, firstLifecycleEvents)
		}
		eventIDs[event.ID] = event.TaskID
		eventsByTask[event.TaskID] = event
	}
	for _, id := range expectedTaskIDs {
		event, ok := eventsByTask[id]
		if !ok {
			t.Fatalf("first sweep did not emit lifecycle event for Task %q: %+v", id, firstLifecycleEvents)
		}
		if event.Type != tasklifecycle.OperationArchive || event.From != models.TaskLifecycleDone || event.To != models.TaskLifecycleArchived || event.Actor != "auto-archive" || event.Reason != "" || !event.Automatic || event.At.IsZero() {
			t.Fatalf("first sweep lifecycle event for Task %q = %+v", id, event)
		}
		var resultEvent *tasklifecycle.Event
		for i := range firstResult.Items {
			if firstResult.Items[i].TaskID == id {
				resultEvent = firstResult.Items[i].Event
				break
			}
		}
		if resultEvent == nil || *resultEvent != event {
			t.Fatalf("first sweep result event for Task %q = %+v, SSE event = %+v", id, resultEvent, event)
		}
		task, err := store.Tasks.Get(id)
		if err != nil || !task.Archived {
			t.Fatalf("partial sweep canonical Task %s = %+v, %v", id, task, err)
		}
	}

	project, err = store.Config.Load()
	if err != nil {
		t.Fatal(err)
	}
	project.Settings.SemanticSearch = nil
	if err := store.Config.Save(project); err != nil {
		t.Fatal(err)
	}

	deadline := time.After(3 * time.Second)
	var recoveryResult *tasklifecycle.BatchResult
	for {
		select {
		case <-deadline:
			t.Fatal("scheduler did not retry pending derived-index checkpoints after configuration recovery")
		default:
			event, lifecycleEvents := waitLifecycleSweepEvents(t, broadcaster.events)
			if len(lifecycleEvents) != 0 {
				t.Fatalf("derived-index retry emitted duplicate lifecycle events: %+v", lifecycleEvents)
			}
			data, ok := event.Data.(map[string]any)
			if !ok || data["error"] != "" {
				continue
			}
			result, ok := data["result"].(*tasklifecycle.BatchResult)
			if ok && result.Completed && result.FailedTaskID == "" && result.Changed == 0 && result.Processed > 0 {
				recoveryResult = result
				break
			}
		}
		if recoveryResult != nil {
			break
		}
	}
	if recoveryResult.Processed != len(expectedTaskIDs) {
		t.Fatalf("recovery sweep processed = %d, want %d: %+v", recoveryResult.Processed, len(expectedTaskIDs), recoveryResult)
	}
	if err := store.WithTaskLifecycleTransaction(context.Background(), func(tx *storage.TaskLifecycleTransaction) error {
		pending, err := tx.ListTaskLifecyclePending(string(tasklifecycle.OperationArchive))
		if err != nil {
			return err
		}
		if len(pending) != 0 {
			t.Fatalf("recovery sweep left archive checkpoints pending: %+v", pending)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	clean, cleanLifecycleEvents := waitLifecycleSweepEvents(t, broadcaster.events)
	if len(cleanLifecycleEvents) != 0 {
		t.Fatalf("clean sweep emitted lifecycle events: %+v", cleanLifecycleEvents)
	}
	cleanData, ok := clean.Data.(map[string]any)
	if !ok || cleanData["error"] != "" {
		t.Fatalf("clean sweep data = %#v", clean.Data)
	}
	cleanResult, ok := cleanData["result"].(*tasklifecycle.BatchResult)
	if !ok || !cleanResult.Completed || cleanResult.FailedTaskID != "" || cleanResult.Processed != 0 || cleanResult.Changed != 0 {
		t.Fatalf("clean sweep result = %#v", cleanData)
	}
}

type lifecycleSweepBroadcaster struct {
	events chan SSEEvent
}

func (b *lifecycleSweepBroadcaster) Broadcast(event SSEEvent) {
	b.events <- event
}

func waitLifecycleSweepEvents(t *testing.T, events <-chan SSEEvent) (SSEEvent, []tasklifecycle.Event) {
	t.Helper()
	deadline := time.After(3 * time.Second)
	lifecycleEvents := []tasklifecycle.Event{}
	for {
		select {
		case event := <-events:
			switch event.Type {
			case "tasks:lifecycle":
				lifecycleEvent, ok := event.Data.(tasklifecycle.Event)
				if !ok {
					t.Fatalf("lifecycle event data = %#v", event.Data)
				}
				lifecycleEvents = append(lifecycleEvents, lifecycleEvent)
			case "tasks:lifecycle-sweep":
				return event, lifecycleEvents
			}
		case <-deadline:
			t.Fatal("timed out waiting for lifecycle sweep event")
		}
	}
}

func TestTaskCreateDerivesLifecycleClocksAndRejectsBackdatedRetentionBypass(t *testing.T) {
	store := newTaskLifecycleRouteStore(t)
	router := chi.NewRouter()
	(&TaskRoutes{store: store, sse: &fakeBroadcaster{}}).Register(router)
	backdated := time.Date(2001, 1, 1, 0, 0, 0, 0, time.UTC)
	body, _ := json.Marshal(map[string]any{
		"id":          "route-create-clock",
		"title":       "clock",
		"status":      "done",
		"completedAt": backdated,
		"archived":    true,
		"archivedAt":  backdated,
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/tasks", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", w.Code, w.Body.String())
	}
	var created models.Task
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Status != "done" || created.CompletedAt == nil || created.CompletedAt.Equal(backdated) || created.Archived || created.ArchivedAt != nil {
		t.Fatalf("server lifecycle fields = %+v", created)
	}
	age := int64((30 * 24 * time.Hour) / time.Millisecond)
	preview := callTaskLifecycleRoute(t, router, "/tasks/batch-archive", map[string]any{"ids": []string{created.ID}, "minimumAgeMs": age})
	if preview.Items[0].Eligible || len(preview.Items[0].Reasons) != 1 || preview.Items[0].Reasons[0].Code != tasklifecycle.ReasonRetentionPending {
		t.Fatalf("backdated retention preview = %+v", preview)
	}
}

func callTaskLifecycleRoute(t *testing.T, router http.Handler, path string, body map[string]any) tasklifecycle.Response {
	t.Helper()
	status, response := callTaskLifecycleRouteAny(t, router, path, body)
	if status != http.StatusOK {
		t.Fatalf("POST %s status=%d response=%+v", path, status, response)
	}
	return response
}

func callTaskLifecycleRouteAny(t *testing.T, router http.Handler, path string, body map[string]any) (int, tasklifecycle.Response) {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	var response tasklifecycle.Response
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode %s: %v", w.Body.String(), err)
	}
	return w.Code, response
}

func newTaskLifecycleRouteStore(t *testing.T) *storage.Store {
	t.Helper()
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("routes"); err != nil {
		t.Fatal(err)
	}
	return store
}

func createTaskLifecycleRouteTask(t *testing.T, store *storage.Store, id string) {
	t.Helper()
	now := time.Now().UTC()
	completed := now.Add(-time.Hour)
	task := &models.Task{ID: id, Title: id, Status: "done", Priority: "medium", CreatedAt: now.Add(-2 * time.Hour), UpdatedAt: completed, CompletedAt: &completed}
	if err := store.Tasks.Create(task); err != nil {
		t.Fatal(err)
	}
}
