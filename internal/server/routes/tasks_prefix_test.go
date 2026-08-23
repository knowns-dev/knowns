package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/storage"
)

func postTaskPrefix(t *testing.T, store *storage.Store, body string) *httptest.ResponseRecorder {
	t.Helper()
	router := taskHTTPContractRouter(store)
	request := httptest.NewRequest(http.MethodPost, "/api/tasks", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, request)
	return w
}

func createdTaskID(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	if w.Code != http.StatusCreated {
		t.Fatalf("POST /api/tasks status=%d body=%s", w.Code, w.Body.String())
	}
	var response struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return response.ID
}

func TestTaskPOSTUsesProjectDefaultPrefix(t *testing.T) {
	store := newTaskLifecycleRouteStore(t)
	project, err := store.Config.Load()
	if err != nil {
		t.Fatalf("Load config: %v", err)
	}
	project.Settings.DefaultTaskIDPrefix = "KN"
	if err := store.Config.Save(project); err != nil {
		t.Fatalf("Save config: %v", err)
	}

	id := createdTaskID(t, postTaskPrefix(t, store, `{"title":"Default prefix"}`))
	if !regexp.MustCompile(`^KN-[0-9A-HJKMNP-TV-Z]{6}$`).MatchString(id) {
		t.Fatalf("task ID = %q, want KN-XXXXXX", id)
	}
}

func TestTaskPOSTCustomPrefixDoesNotMutateProjectDefault(t *testing.T) {
	store := newTaskLifecycleRouteStore(t)
	project, err := store.Config.Load()
	if err != nil {
		t.Fatalf("Load config: %v", err)
	}
	project.Settings.DefaultTaskIDPrefix = "KN"
	if err := store.Config.Save(project); err != nil {
		t.Fatalf("Save config: %v", err)
	}

	id := createdTaskID(t, postTaskPrefix(t, store, `{"title":"Custom prefix","prefix":"lab"}`))
	if !strings.HasPrefix(id, "LAB-") {
		t.Fatalf("task ID = %q, want LAB prefix", id)
	}

	reloaded, err := store.Config.Load()
	if err != nil {
		t.Fatalf("Reload config: %v", err)
	}
	if reloaded.Settings.DefaultTaskIDPrefix != "KN" {
		t.Fatalf("custom prefix mutated project default to %q", reloaded.Settings.DefaultTaskIDPrefix)
	}
}

func TestTaskPOSTRejectsInvalidPrefix(t *testing.T) {
	store := newTaskLifecycleRouteStore(t)
	w := postTaskPrefix(t, store, `{"title":"Invalid prefix","prefix":"1bad"}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("POST status=%d body=%s, want 400", w.Code, w.Body.String())
	}
	tasks, err := store.Tasks.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(tasks) != 0 {
		t.Fatalf("rejected request created %d tasks, want 0", len(tasks))
	}
}

func TestTaskPOSTFallsBackToLegacyIDs(t *testing.T) {
	store := newTaskLifecycleRouteStore(t)
	id := createdTaskID(t, postTaskPrefix(t, store, `{"title":"Legacy id"}`))
	if !regexp.MustCompile(`^[0-9a-z]{6}$`).MatchString(id) {
		t.Fatalf("task ID = %q, want legacy six-character base36 format", id)
	}
}

func TestTaskPOSTPreservesCallerSuppliedID(t *testing.T) {
	store := newTaskLifecycleRouteStore(t)
	id := createdTaskID(t, postTaskPrefix(t, store, `{"id":"imported1","title":"Imported","prefix":"LAB"}`))
	if id != "imported1" {
		t.Fatalf("task ID = %q, want imported1", id)
	}
}

func TestConfigExposesAndUpdatesTaskIDPrefix(t *testing.T) {
	store := newTaskLifecycleRouteStore(t)
	router := configLifecycleRouter(store, true)

	request := httptest.NewRequest(http.MethodPatch, "/api/config", strings.NewReader(`{"defaultTaskIdPrefix":" kn "}`))
	request.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, request)
	if w.Code != http.StatusOK {
		t.Fatalf("PATCH status=%d body=%s", w.Code, w.Body.String())
	}

	project, err := store.Config.Load()
	if err != nil {
		t.Fatalf("Load config: %v", err)
	}
	if project.Settings.DefaultTaskIDPrefix != "KN" {
		t.Fatalf("stored task ID prefix = %q, want KN", project.Settings.DefaultTaskIDPrefix)
	}

	bad := httptest.NewRequest(http.MethodPatch, "/api/config", strings.NewReader(`{"defaultTaskIdPrefix":"1bad"}`))
	bad.Header.Set("Content-Type", "application/json")
	badRecorder := httptest.NewRecorder()
	router.ServeHTTP(badRecorder, bad)
	if badRecorder.Code == http.StatusOK {
		t.Fatalf("PATCH with invalid prefix succeeded: %s", badRecorder.Body.String())
	}
	if !strings.Contains(badRecorder.Body.String(), "defaultTaskIdPrefix") {
		t.Fatalf("invalid prefix error did not name the field: %s", badRecorder.Body.String())
	}
}
