package routes

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/howznguyen/knowns/internal/decisionreview"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

func TestDecisionRoutesLifecycle(t *testing.T) {
	store := setupDecisionRouteStore(t)
	sse := &fakeBroadcaster{}
	r := chi.NewRouter()
	(&DecisionRoutes{store: store, sse: sse}).Register(r)

	draft := createDecisionViaRoute(t, r, map[string]any{
		"title":    "Draft route decision",
		"decision": "Create draft first.",
	})
	if draft.Status != models.DecisionStatusDraft {
		t.Fatalf("draft status = %q, want draft", draft.Status)
	}

	accepted := createDecisionViaRoute(t, r, map[string]any{
		"title":       "Accepted route decision",
		"relatedDocs": []string{"specs/vector"},
	})
	if accepted.Status != models.DecisionStatusAccepted {
		t.Fatalf("accepted status = %q, want accepted", accepted.Status)
	}

	duplicateBody, _ := json.Marshal(map[string]any{"title": "Accepted route decision"})
	req := httptest.NewRequest("POST", "/decisions", bytes.NewReader(duplicateBody))
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusConflict {
		t.Fatalf("duplicate POST /decisions status = %d, want 409: %s", w.Code, w.Body.String())
	}
	var reviewResult decisionreview.Result
	if err := json.Unmarshal(w.Body.Bytes(), &reviewResult); err != nil {
		t.Fatalf("decode review result: %v\n%s", err, w.Body.String())
	}
	if reviewResult.Status != decisionreview.ResultReviewRequired || len(reviewResult.Matches) != 1 {
		t.Fatalf("review result = %+v, want review_required match", reviewResult)
	}
	entriesAfterReview, err := store.Decisions.List()
	if err != nil {
		t.Fatalf("List after review: %v", err)
	}
	if len(entriesAfterReview) != 2 {
		t.Fatalf("len(entriesAfterReview) = %d, want no-write count 2", len(entriesAfterReview))
	}

	req = httptest.NewRequest("GET", "/decisions", nil)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /decisions status = %d, want 200", w.Code)
	}
	var listed []models.DecisionEntry
	if err := json.Unmarshal(w.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode list: %v\n%s", err, w.Body.String())
	}
	if len(listed) != 1 || listed[0].ID != accepted.ID {
		t.Fatalf("default list = %+v, want only %s", listed, accepted.ID)
	}

	linkBody, _ := json.Marshal(map[string]any{"relatedTasks": []string{"yken4b"}})
	req = httptest.NewRequest("POST", "/decisions/"+draft.ID+"/link", bytes.NewReader(linkBody))
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("POST /decisions/{id}/link status = %d, want 200: %s", w.Code, w.Body.String())
	}
	var linked models.DecisionEntry
	if err := json.Unmarshal(w.Body.Bytes(), &linked); err != nil {
		t.Fatalf("decode link: %v", err)
	}
	if linked.Status != models.DecisionStatusAccepted || linked.RelatedTasks[0] != "yken4b" {
		t.Fatalf("linked decision = %+v", linked)
	}

	supersedeBody, _ := json.Marshal(map[string]string{"newId": accepted.ID})
	req = httptest.NewRequest("POST", "/decisions/"+linked.ID+"/supersede", bytes.NewReader(supersedeBody))
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("POST /decisions/{id}/supersede status = %d, want 200: %s", w.Code, w.Body.String())
	}
	var result struct {
		Superseded models.DecisionEntry `json:"superseded"`
		Current    models.DecisionEntry `json:"current"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode supersede: %v", err)
	}
	if result.Superseded.Status != models.DecisionStatusSuperseded || result.Current.Supersedes[0] != linked.ID {
		t.Fatalf("supersede result = %+v", result)
	}
	if len(sse.events) != 4 {
		t.Fatalf("SSE event count = %d, want 4", len(sse.events))
	}
}

func createDecisionViaRoute(t *testing.T, r http.Handler, body map[string]any) models.DecisionEntry {
	t.Helper()
	data, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", "/decisions", bytes.NewReader(data))
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("POST /decisions status = %d, want 201: %s", w.Code, w.Body.String())
	}
	var decision models.DecisionEntry
	if err := json.Unmarshal(w.Body.Bytes(), &decision); err != nil {
		t.Fatalf("decode create: %v", err)
	}
	return decision
}

func setupDecisionRouteStore(t *testing.T) *storage.Store {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("decision-route-test"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	return store
}
