package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/howznguyen/knowns/internal/models"
)

// syncSpecACs must keep counting a task that fulfils spec ACs after it is
// archived, otherwise spec coverage silently drops when the board is tidied.
func TestSyncSpecACsCountsArchivedTasks(t *testing.T) {
	store := newTaskLifecycleRouteStore(t)
	if err := store.Docs.Create(&models.Doc{
		Path:        "specs/coverage",
		Title:       "Coverage spec",
		Description: "spec",
		Content:     "## Acceptance Criteria\n\n- [ ] AC-1: something\n",
	}); err != nil {
		t.Fatalf("create spec doc: %v", err)
	}
	if err := store.Tasks.Create(&models.Task{
		ID: "arcspec", Title: "Fulfils AC-1", Status: "done", Priority: "medium",
		Spec: "specs/coverage", Fulfills: []string{"AC-1"},
	}); err != nil {
		t.Fatalf("create task: %v", err)
	}

	router := chi.NewRouter()
	(&TaskRoutes{store: store, sse: &fakeBroadcaster{}}).Register(router)

	if got := callSyncSpecACs(t, router); got != 1 {
		t.Fatalf("synced before archive = %d, want 1", got)
	}

	if err := store.Tasks.Archive("arcspec"); err != nil {
		t.Fatalf("archive task: %v", err)
	}

	if got := callSyncSpecACs(t, router); got != 1 {
		t.Fatalf("synced after archive = %d, want 1 (coverage must not drop on archive)", got)
	}
}

func callSyncSpecACs(t *testing.T, router *chi.Mux) int {
	t.Helper()
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/tasks/sync-spec-acs", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Synced int `json:"synced"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v (body %s)", err, rec.Body.String())
	}
	return body.Synced
}
