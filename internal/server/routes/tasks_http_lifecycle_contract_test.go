package routes

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

type taskHTTPContract struct {
	ID             string                    `json:"id"`
	Status         string                    `json:"status"`
	Archived       bool                      `json:"archived"`
	LifecycleState models.TaskLifecycleState `json:"lifecycleState"`
	CompletedAt    *time.Time                `json:"completedAt"`
	ArchivedAt     *time.Time                `json:"archivedAt"`
}

func TestTaskHTTPResponsesDeriveLifecycleStateWithoutPersistence(t *testing.T) {
	store := newTaskLifecycleRouteStore(t)
	router := taskHTTPContractRouter(store)

	created := callTaskHTTPContract(t, router, http.MethodPost, "/api/tasks", []byte(`{
		"id":"route-state","title":"state","status":"todo","priority":"medium",
		"archived":true,"lifecycleState":"archived"
	}`), http.StatusCreated)
	if created.LifecycleState != models.TaskLifecycleActive || created.Archived || created.Status != "todo" {
		t.Fatalf("create response = %#v", created)
	}
	assertTaskMarkdownOmitsLifecycleState(t, store, "tasks", "route-state")

	updated := callTaskHTTPContract(t, router, http.MethodPut, "/api/tasks/route-state", []byte(`{
		"status":"done","archived":true,"lifecycleState":"archived"
	}`), http.StatusOK)
	if updated.LifecycleState != models.TaskLifecycleDone || updated.Archived || updated.Status != "done" || updated.CompletedAt == nil {
		t.Fatalf("update response = %#v", updated)
	}

	got := callTaskHTTPContract(t, router, http.MethodGet, "/api/tasks/route-state", nil, http.StatusOK)
	if got.LifecycleState != models.TaskLifecycleDone || got.CompletedAt == nil {
		t.Fatalf("done GET response = %#v", got)
	}
	if err := store.Tasks.Archive("route-state"); err != nil {
		t.Fatal(err)
	}
	archived := callTaskHTTPContract(t, router, http.MethodGet, "/api/tasks/route-state", nil, http.StatusOK)
	if archived.LifecycleState != models.TaskLifecycleArchived || !archived.Archived || archived.Status != "done" {
		t.Fatalf("archived GET response = %#v", archived)
	}
	assertTaskMarkdownOmitsLifecycleState(t, store, "archive", "route-state")
}

func TestTaskHTTPListHistoricalVisibilityAndStableLifecycleGrouping(t *testing.T) {
	store := newTaskLifecycleRouteStore(t)
	now := time.Now().UTC()
	completed := now.Add(-time.Hour)
	for _, task := range []*models.Task{
		{ID: "z-active", Title: "z active", Status: "todo", Priority: "medium", CreatedAt: now, UpdatedAt: now},
		{ID: "a-active", Title: "a active", Status: "in-progress", Priority: "medium", CreatedAt: now, UpdatedAt: now},
		{ID: "z-done", Title: "z done", Status: "done", Priority: "medium", CreatedAt: now, UpdatedAt: completed, CompletedAt: &completed},
		{ID: "a-done", Title: "a done", Status: "done", Priority: "medium", CreatedAt: now, UpdatedAt: completed, CompletedAt: &completed},
		{ID: "z-archived", Title: "z archived", Status: "done", Priority: "medium", CreatedAt: now, UpdatedAt: completed, CompletedAt: &completed},
		{ID: "a-archived", Title: "a archived", Status: "done", Priority: "medium", CreatedAt: now, UpdatedAt: completed, CompletedAt: &completed},
	} {
		if err := store.Tasks.Create(task); err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range []string{"z-archived", "a-archived"} {
		if err := store.Tasks.Archive(id); err != nil {
			t.Fatal(err)
		}
	}
	router := taskHTTPContractRouter(store)

	defaultTasks := callTaskHTTPList(t, router, "/api/tasks", http.StatusOK)
	assertTaskHTTPOrder(t, defaultTasks, []string{"a-active", "z-active", "a-done", "z-done"}, []models.TaskLifecycleState{
		models.TaskLifecycleActive, models.TaskLifecycleActive, models.TaskLifecycleDone, models.TaskLifecycleDone,
	})
	defaultFalse := callTaskHTTPList(t, router, "/api/tasks?includeHistorical=false", http.StatusOK)
	assertTaskHTTPOrder(t, defaultFalse, []string{"a-active", "z-active", "a-done", "z-done"}, nil)

	historical := callTaskHTTPList(t, router, "/api/tasks?includeHistorical=true", http.StatusOK)
	assertTaskHTTPOrder(t, historical, []string{"a-active", "z-active", "a-done", "z-done", "a-archived", "z-archived"}, []models.TaskLifecycleState{
		models.TaskLifecycleActive, models.TaskLifecycleActive, models.TaskLifecycleDone, models.TaskLifecycleDone,
		models.TaskLifecycleArchived, models.TaskLifecycleArchived,
	})

	for _, path := range []string{
		"/api/tasks?includeHistorical=yes",
		"/api/tasks?includeHistorical=TRUE",
		"/api/tasks?includeHistorical=true&includeHistorical=false",
	} {
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "includeHistorical") {
			t.Fatalf("GET %s status=%d body=%s", path, w.Code, w.Body.String())
		}
	}
}

func taskHTTPContractRouter(store *storage.Store) http.Handler {
	api := chi.NewRouter()
	(&TaskRoutes{store: store, sse: &fakeBroadcaster{}}).Register(api)
	router := chi.NewRouter()
	router.Mount("/api", api)
	return router
}

func callTaskHTTPContract(t *testing.T, router http.Handler, method, path string, body []byte, wantStatus int) taskHTTPContract {
	t.Helper()
	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	router.ServeHTTP(w, request)
	if w.Code != wantStatus {
		t.Fatalf("%s %s status=%d body=%s", method, path, w.Code, w.Body.String())
	}
	var response taskHTTPContract
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode Task response %s: %v", w.Body.String(), err)
	}
	return response
}

func callTaskHTTPList(t *testing.T, router http.Handler, path string, wantStatus int) []taskHTTPContract {
	t.Helper()
	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
	if w.Code != wantStatus {
		t.Fatalf("GET %s status=%d body=%s", path, w.Code, w.Body.String())
	}
	var response []taskHTTPContract
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode Task list %s: %v", w.Body.String(), err)
	}
	return response
}

func assertTaskHTTPOrder(t *testing.T, tasks []taskHTTPContract, wantIDs []string, wantStates []models.TaskLifecycleState) {
	t.Helper()
	if len(tasks) != len(wantIDs) {
		t.Fatalf("Task count=%d want=%d: %#v", len(tasks), len(wantIDs), tasks)
	}
	for index, wantID := range wantIDs {
		if tasks[index].ID != wantID {
			t.Fatalf("Task[%d].id=%q want=%q: %#v", index, tasks[index].ID, wantID, tasks)
		}
		if wantStates != nil && tasks[index].LifecycleState != wantStates[index] {
			t.Fatalf("Task[%d].lifecycleState=%q want=%q", index, tasks[index].LifecycleState, wantStates[index])
		}
	}
}

func assertTaskMarkdownOmitsLifecycleState(t *testing.T, store *storage.Store, dir, taskID string) {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(store.Root, dir))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasPrefix(entry.Name(), "task-"+taskID) {
			data, err := os.ReadFile(filepath.Join(store.Root, dir, entry.Name()))
			if err != nil {
				t.Fatal(err)
			}
			if bytes.Contains(data, []byte("lifecycleState")) {
				t.Fatalf("derived lifecycleState persisted in %s:\n%s", entry.Name(), data)
			}
			return
		}
	}
	t.Fatalf("Task %s file not found in %s", taskID, dir)
}
