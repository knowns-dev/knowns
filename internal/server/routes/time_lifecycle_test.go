package routes

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
