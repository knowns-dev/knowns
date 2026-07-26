package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

func TestValidateSDDIncludesDecisionContractStats(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("validate-route-test"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	now := time.Now().UTC()
	if err := store.Docs.Create(&models.Doc{
		Path: "specs/decision-contract", Title: "Decision contract", Tags: []string{"spec", "approved"}, CreatedAt: now, UpdatedAt: now,
		Content: "## Locked Decisions\n\n- D1: Keep the contract stable.\n\n## System Decision Impact\n\n- Impact: none.",
	}); err != nil {
		t.Fatalf("create spec: %v", err)
	}
	for _, task := range []*models.Task{
		{ID: "done01", Title: "Compliant", Status: "done", Priority: "medium", Spec: "specs/decision-contract", ImplementationNotes: "Spec Decision Compliance: D1=pass", AcceptanceCriteria: []models.AcceptanceCriterion{{Text: "Done", Completed: true}}},
		{ID: "work01", Title: "Unassessed", Status: "in-progress", Priority: "medium", Spec: "specs/decision-contract", AcceptanceCriteria: []models.AcceptanceCriterion{{Text: "Pending"}}},
	} {
		if err := store.Tasks.Create(task); err != nil {
			t.Fatalf("create task %s: %v", task.ID, err)
		}
	}

	router := chi.NewRouter()
	(&ValidateRoutes{store: store}).Register(router)
	req := httptest.NewRequest("GET", "/validate/sdd", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /validate/sdd status = %d: %s", w.Code, w.Body.String())
	}
	var response struct {
		Stats struct {
			Decisions map[string]int `json:"decisions"`
		} `json:"stats"`
		Warnings []SDDWarning `json:"warnings"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.Stats.Decisions["compliant"] != 1 || response.Stats.Decisions["unassessed"] != 1 || response.Stats.Decisions["impactDeclared"] != 1 {
		t.Fatalf("decision stats = %#v", response.Stats.Decisions)
	}
	foundUnassessed := false
	for _, warning := range response.Warnings {
		if warning.Type == "SDD_SPEC_DECISIONS_UNASSESSED" && warning.Entity == "work01" {
			foundUnassessed = true
		}
	}
	if !foundUnassessed {
		t.Fatalf("warnings = %#v, want unassessed task warning", response.Warnings)
	}
}
