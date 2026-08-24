package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

// Search is discovery: an archived Task is still findable when the caller asks
// for history, and stays out of the default result set.
func TestSearchRouteIncludeHistorical(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("search-archived"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	for _, id := range []string{"sactive", "sarchived"} {
		if err := store.Tasks.Create(&models.Task{
			ID: id, Title: "Zebraquokka telemetry " + id, Status: "done", Priority: "medium",
		}); err != nil {
			t.Fatalf("create %s: %v", id, err)
		}
	}
	if err := store.Tasks.Archive("sarchived"); err != nil {
		t.Fatalf("archive: %v", err)
	}

	r := chi.NewRouter()
	(&SearchRoutes{store: store}).Register(r)

	taskIDs := func(query string) map[string]bool {
		t.Helper()
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/search?q=Zebraquokka&type=task&mode=keyword"+query, nil))
		if w.Code != http.StatusOK {
			t.Fatalf("GET /search%s status = %d, body %s", query, w.Code, w.Body.String())
		}
		var payload struct {
			Tasks []struct {
				ID string `json:"id"`
			} `json:"tasks"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
			t.Fatalf("decode: %v", err)
		}
		out := map[string]bool{}
		for _, task := range payload.Tasks {
			out[task.ID] = true
		}
		return out
	}

	def := taskIDs("")
	if !def["sactive"] {
		t.Errorf("default search missing active task: %v", def)
	}
	if def["sarchived"] {
		t.Errorf("default search must exclude archived task: %v", def)
	}

	withArchived := taskIDs("&includeHistorical=true")
	if !withArchived["sactive"] || !withArchived["sarchived"] {
		t.Errorf("includeHistorical search = %v, want both tasks", withArchived)
	}

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/search?q=Zebraquokka&includeHistorical=maybe", nil))
	if w.Code != http.StatusBadRequest {
		t.Errorf("invalid includeHistorical status = %d, want 400", w.Code)
	}
}
