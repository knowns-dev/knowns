package routes

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/howznguyen/knowns/internal/tasklifecycle"
)

func TestTimeRoutesUseAtomicLifecycleMutationsAndRejectArchivedTask(t *testing.T) {
	store := newTaskLifecycleRouteStore(t)
	now := time.Now().UTC()
	if err := store.Tasks.Create(&models.Task{ID: "route-time", Title: "time", Status: "todo", Priority: "medium", CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	(&TimeRoutes{store: store, sse: &fakeBroadcaster{}}).Register(router)

	status := callTimeRoute(t, router, "/time/add", map[string]any{"taskId": "route-time", "duration": 45, "note": "atomic"})
	if status != http.StatusOK {
		t.Fatalf("add status = %d", status)
	}
	assertRouteTaskTime(t, store, "route-time", 45, 1)

	service := tasklifecycle.New(store)
	if _, err := service.UpdateTask(t.Context(), "route-time", tasklifecycle.TaskUpdateOptions{Mutate: func(task *models.Task) error { task.Status = "done"; return nil }}); err != nil {
		t.Fatal(err)
	}
	if result, err := service.Archive(t.Context(), "route-time", tasklifecycle.ArchiveOptions{}); err != nil || !result.Changed {
		t.Fatalf("archive = %+v, %v", result, err)
	}
	status = callTimeRoute(t, router, "/time/add", map[string]any{"taskId": "route-time", "duration": 15})
	if status != http.StatusConflict {
		t.Fatalf("archived add status = %d", status)
	}
	assertRouteTaskTime(t, store, "route-time", 45, 1)

	completed := now.Add(-time.Hour)
	if err := store.Tasks.Create(&models.Task{ID: "route-stop", Title: "stop", Status: "done", Priority: "medium", CreatedAt: now.Add(-2 * time.Hour), UpdatedAt: completed, CompletedAt: &completed}); err != nil {
		t.Fatal(err)
	}
	if err := store.Time.SaveState(&models.TimeState{Active: []models.ActiveTimer{{TaskID: "route-stop", StartedAt: now.Add(-time.Minute).Format(time.RFC3339Nano)}}}); err != nil {
		t.Fatal(err)
	}
	status = callTimeRoute(t, router, "/time/stop", map[string]any{"taskId": "route-stop"})
	if status != http.StatusOK {
		t.Fatalf("stop status = %d", status)
	}
	assertRouteTaskTime(t, store, "route-stop", 60, 1)
}

func TestTimeRoutesRejectStaleExpectedHashWithoutSideEffects(t *testing.T) {
	store := newTaskLifecycleRouteStore(t)
	now := time.Now().UTC()
	if err := store.Tasks.Create(&models.Task{ID: "route-time-occ", Title: "secret time title", Status: "todo", Priority: "medium", CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	service := tasklifecycle.New(store)
	base, err := store.Tasks.Get("route-time-occ")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.UpdateTask(t.Context(), base.ID, tasklifecycle.TaskUpdateOptions{ExpectedHash: base.CanonicalHash, Mutate: func(task *models.Task) error { task.Description = "secret description"; return nil }}); err != nil {
		t.Fatal(err)
	}
	updated, _ := store.Tasks.Get(base.ID)
	historyBefore, _ := store.Versions.GetHistory(base.ID)
	broadcaster := &fakeBroadcaster{}
	router := chi.NewRouter()
	(&TimeRoutes{store: store, sse: broadcaster}).Register(router)
	data, _ := json.Marshal(map[string]any{"taskId": base.ID, "duration": 30, "expectedHash": base.CanonicalHash})
	req := httptest.NewRequest(http.MethodPost, "/time/add", bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusConflict || strings.Contains(w.Body.String(), "secret") {
		t.Fatalf("stale add status/body = %d/%s", w.Code, w.Body.String())
	}
	after, _ := store.Tasks.Get(base.ID)
	entries, _ := store.Time.GetEntries(base.ID)
	historyAfter, _ := store.Versions.GetHistory(base.ID)
	if after.CanonicalHash != updated.CanonicalHash || len(entries) != 0 || len(historyAfter.Versions) != len(historyBefore.Versions) || len(broadcaster.events) != 0 {
		t.Fatalf("stale add side effects: task=%#v entries=%#v history=%d/%d events=%d", after, entries, len(historyAfter.Versions), len(historyBefore.Versions), len(broadcaster.events))
	}

	if err := store.Time.SaveState(&models.TimeState{Active: []models.ActiveTimer{{TaskID: base.ID, StartedAt: now.Add(-time.Minute).Format(time.RFC3339Nano)}}}); err != nil {
		t.Fatal(err)
	}
	data, _ = json.Marshal(map[string]any{"taskId": base.ID, "expectedHash": base.CanonicalHash})
	req = httptest.NewRequest(http.MethodPost, "/time/stop", bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusConflict || strings.Contains(w.Body.String(), "secret") {
		t.Fatalf("stale stop status/body = %d/%s", w.Code, w.Body.String())
	}
	state, _ := store.Time.GetState()
	entries, _ = store.Time.GetEntries(base.ID)
	if len(state.Active) != 1 || len(entries) != 0 || len(broadcaster.events) != 0 {
		t.Fatalf("stale stop side effects: state=%#v entries=%#v events=%d", state, entries, len(broadcaster.events))
	}
}

func TestTimeRoutesStopAllIsAtomicForStaleLaterTask(t *testing.T) {
	store := newTaskLifecycleRouteStore(t)
	now := time.Now().UTC()
	for _, id := range []string{"route-stop-a", "route-stop-z"} {
		if err := store.Tasks.Create(&models.Task{ID: id, Title: id, Status: "todo", Priority: "medium", CreatedAt: now, UpdatedAt: now}); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.Time.SaveState(&models.TimeState{Active: []models.ActiveTimer{
		{TaskID: "route-stop-a", StartedAt: now.Add(-time.Minute).Format(time.RFC3339Nano)},
		{TaskID: "route-stop-z", StartedAt: now.Add(-2 * time.Minute).Format(time.RFC3339Nano)},
	}}); err != nil {
		t.Fatal(err)
	}
	baseA, _ := store.Tasks.Get("route-stop-a")
	baseZ, _ := store.Tasks.Get("route-stop-z")
	if _, err := tasklifecycle.New(store).UpdateTask(t.Context(), baseZ.ID, tasklifecycle.TaskUpdateOptions{ExpectedHash: baseZ.CanonicalHash, Mutate: func(task *models.Task) error { task.Description = "newer"; return nil }}); err != nil {
		t.Fatal(err)
	}
	broadcaster := &fakeBroadcaster{}
	router := chi.NewRouter()
	(&TimeRoutes{store: store, sse: broadcaster}).Register(router)
	body, _ := json.Marshal(map[string]any{"all": true, "expectedHashes": map[string]string{"route-stop-a": baseA.CanonicalHash, "route-stop-z": baseZ.CanonicalHash}})
	req := httptest.NewRequest(http.MethodPost, "/time/stop", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusConflict || strings.Contains(w.Body.String(), "newer") {
		t.Fatalf("stale all stop status/body=%d/%s", w.Code, w.Body.String())
	}
	state, _ := store.Time.GetState()
	entriesA, _ := store.Time.GetEntries(baseA.ID)
	entriesZ, _ := store.Time.GetEntries(baseZ.ID)
	if len(state.Active) != 2 || len(entriesA) != 0 || len(entriesZ) != 0 || len(broadcaster.events) != 0 {
		t.Fatalf("stale all stop side effects: state=%#v entries=%d/%d events=%d", state, len(entriesA), len(entriesZ), len(broadcaster.events))
	}
}

func TestTimeRoutesStopAllEmptySetIsNoopWithoutSSE(t *testing.T) {
	store := newTaskLifecycleRouteStore(t)
	broadcaster := &fakeBroadcaster{}
	router := chi.NewRouter()
	(&TimeRoutes{store: store, sse: broadcaster}).Register(router)

	req := httptest.NewRequest(http.MethodPost, "/time/stop", strings.NewReader(`{"all":true}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("empty stop-all status = %d, body=%s", w.Code, w.Body.String())
	}
	if len(broadcaster.events) != 0 {
		t.Fatalf("empty stop-all emitted %d SSE events", len(broadcaster.events))
	}
}

func callTimeRoute(t *testing.T, router http.Handler, path string, body map[string]any) int {
	t.Helper()
	data, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w.Code
}

func assertRouteTaskTime(t *testing.T, store *storage.Store, taskID string, wantSeconds, wantEntries int) {
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
		t.Fatalf("Task.TimeSpent=%d entries total=%d count=%d, want %d/%d", task.TimeSpent, total, len(entries), wantSeconds, wantEntries)
	}
}
