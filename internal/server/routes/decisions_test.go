package routes

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/howznguyen/knowns/internal/decisionmigration"
	"github.com/howznguyen/knowns/internal/decisionreview"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

func TestDecisionRoutesLifecycle(t *testing.T) {
	store := setupDecisionRouteStore(t)
	if err := store.Tasks.Create(&models.Task{
		ID: "verify1", Title: "Verify decision", Status: "done", Priority: "medium", Labels: []string{},
		AcceptanceCriteria: []models.AcceptanceCriterion{{Text: "Verified", Completed: true}},
	}); err != nil {
		t.Fatalf("create verification task: %v", err)
	}
	sse := &fakeBroadcaster{}
	r := chi.NewRouter()
	(&DecisionRoutes{store: store, sse: sse}).Register(r)

	draft := createDecisionViaRoute(t, r, map[string]any{
		"title":    "Store audit timestamps for cache pruning",
		"decision": "Record cache audit timestamps before pruning stale entries.",
	})
	if draft.Status != models.DecisionStatusDraft {
		t.Fatalf("draft status = %q, want draft", draft.Status)
	}

	accepted := createDecisionViaRoute(t, r, map[string]any{
		"title":        "Accepted route decision",
		"sources":      []string{"https://example.com/vector-spec"},
		"relatedTasks": []string{"verify1"},
	})
	if accepted.Status != models.DecisionStatusDraft {
		t.Fatalf("linked status = %q, want draft", accepted.Status)
	}
	req := httptest.NewRequest("POST", "/decisions/"+accepted.ID+"/accept", bytes.NewReader([]byte("{}")))
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("POST /decisions/{id}/accept status = %d: %s", w.Code, w.Body.String())
	}
	var acceptedResult decisionreview.Result
	if err := json.Unmarshal(w.Body.Bytes(), &acceptedResult); err != nil {
		t.Fatalf("decode accept: %v", err)
	}
	accepted = *acceptedResult.Decision

	duplicateBody, _ := json.Marshal(map[string]any{
		"title":        "Accepted route decision",
		"sources":      []string{"https://example.com/vector-spec-v2"},
		"relatedTasks": []string{"verify1"},
	})
	req = httptest.NewRequest("POST", "/decisions", bytes.NewReader(duplicateBody))
	w = httptest.NewRecorder()
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
	if len(entriesAfterReview) != 3 {
		t.Fatalf("len(entriesAfterReview) = %d, want persisted candidate count 3", len(entriesAfterReview))
	}

	req = httptest.NewRequest("GET", "/decisions/review/inbox", nil)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /decisions/review/inbox status = %d: %s", w.Code, w.Body.String())
	}
	var inbox []models.DecisionEntry
	if err := json.Unmarshal(w.Body.Bytes(), &inbox); err != nil {
		t.Fatalf("decode review inbox: %v", err)
	}
	var persistedReview *models.DecisionEntry
	for i := range inbox {
		if inbox[i].ID == reviewResult.Candidate.ID {
			persistedReview = &inbox[i]
			break
		}
	}
	if persistedReview == nil || persistedReview.ReviewState != models.DecisionReviewStateNeedsResolution {
		t.Fatalf("review inbox = %+v", inbox)
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

	linkBody, _ := json.Marshal(map[string]any{"relatedTasks": []string{"verify1"}, "sources": []string{"https://example.com/draft-spec"}})
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
	if linked.Status != models.DecisionStatusDraft || linked.RelatedTasks[0] != "verify1" {
		t.Fatalf("linked decision = %+v", linked)
	}
	req = httptest.NewRequest("POST", "/decisions/"+linked.ID+"/accept", bytes.NewReader([]byte("{}")))
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("POST linked /accept status = %d: %s", w.Code, w.Body.String())
	}
	var linkedResult decisionreview.Result
	if err := json.Unmarshal(w.Body.Bytes(), &linkedResult); err != nil {
		t.Fatalf("decode linked accept: %v", err)
	}
	linked = *linkedResult.Decision

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
	if len(sse.events) != 7 {
		t.Fatalf("SSE event count = %d, want 7", len(sse.events))
	}
}

func TestDecisionRoutesResolvePersistedCandidateByCandidateID(t *testing.T) {
	store := setupDecisionRouteStore(t)
	if err := store.Tasks.Create(&models.Task{
		ID: "verify2", Title: "Verify replacement", Status: "done", Priority: "medium", Labels: []string{},
		AcceptanceCriteria: []models.AcceptanceCriterion{{Text: "Verified", Completed: true}},
	}); err != nil {
		t.Fatalf("create task: %v", err)
	}
	router := chi.NewRouter()
	(&DecisionRoutes{store: store}).Register(router)

	current := createDecisionViaRoute(t, router, map[string]any{
		"title":        "Use Chroma as default vector DB",
		"decision":     "Use Chroma as the default vector database.",
		"sources":      []string{"https://example.com/chroma"},
		"relatedTasks": []string{"verify2"},
	})
	req := httptest.NewRequest(http.MethodPost, "/decisions/"+current.ID+"/accept", bytes.NewReader([]byte("{}")))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("accept current status = %d: %s", w.Code, w.Body.String())
	}

	createBody, _ := json.Marshal(map[string]any{
		"title":        "Use Qdrant as default vector DB",
		"decision":     "Use Qdrant as the default vector database.",
		"sources":      []string{"https://example.com/qdrant"},
		"relatedTasks": []string{"verify2"},
	})
	req = httptest.NewRequest(http.MethodPost, "/decisions", bytes.NewReader(createBody))
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusConflict {
		t.Fatalf("create conflict status = %d: %s", w.Code, w.Body.String())
	}
	var review decisionreview.Result
	if err := json.Unmarshal(w.Body.Bytes(), &review); err != nil {
		t.Fatalf("decode review: %v", err)
	}

	resolveBody, _ := json.Marshal(map[string]any{
		"candidateId": review.Candidate.ID,
		"targetId":    current.ID,
		"resolution":  decisionreview.ResolutionSupersedeExisting,
	})
	req = httptest.NewRequest(http.MethodPost, "/decisions/review/resolve", bytes.NewReader(resolveBody))
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("resolve status = %d: %s", w.Code, w.Body.String())
	}
	var resolved decisionreview.Result
	if err := json.Unmarshal(w.Body.Bytes(), &resolved); err != nil {
		t.Fatalf("decode resolved: %v", err)
	}
	if resolved.Current == nil || resolved.Superseded == nil ||
		resolved.Current.ID != review.Candidate.ID ||
		resolved.Superseded.ID != current.ID {
		t.Fatalf("resolved = %+v", resolved)
	}

	req = httptest.NewRequest(http.MethodGet, "/decisions/review/inbox", nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("inbox after resolution status=%d body=%s", w.Code, w.Body.String())
	}
	var inbox []models.DecisionEntry
	if err := json.Unmarshal(w.Body.Bytes(), &inbox); err != nil {
		t.Fatalf("decode inbox after resolution: %v", err)
	}
	for _, candidate := range inbox {
		if candidate.ID == review.Candidate.ID {
			t.Fatalf("resolved candidate remained in inbox: %+v", candidate)
		}
	}
}

func TestDecisionRoutesMigrationEntryPoints(t *testing.T) {
	store := setupDecisionRouteStore(t)
	memoryID := "routem1"
	path := filepath.Join(store.Root, "memory", models.MemoryFileName(memoryID))
	raw := "---\nid: routem1\ntitle: Legacy route decision\nlayer: project\ncategory: decision\nstatus: active\nsources: []\ntags: []\ncreatedAt: '2026-07-23T10:00:00Z'\nupdatedAt: '2026-07-23T10:00:00Z'\n---\n\nUse a System Decision.\n"
	if err := os.WriteFile(path, []byte(raw), 0o644); err != nil {
		t.Fatal(err)
	}
	sse := &fakeBroadcaster{}
	router := chi.NewRouter()
	(&DecisionRoutes{store: store, sse: sse}).Register(router)

	req := httptest.NewRequest(http.MethodGet, "/decisions/migration/preview", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("preview status = %d: %s", w.Code, w.Body.String())
	}
	var preview decisionmigration.PreviewReport
	if err := json.Unmarshal(w.Body.Bytes(), &preview); err != nil || preview.Counts.Total != 1 {
		t.Fatalf("preview = %+v err=%v", preview, err)
	}
	after, _ := os.ReadFile(path)
	if string(after) != raw {
		t.Fatal("route migration preview wrote memory")
	}

	body, _ := json.Marshal(map[string]any{"selections": []decisionmigration.Selection{{MemoryID: memoryID, Resolution: decisionmigration.ResolutionCreateDecision}}})
	req = httptest.NewRequest(http.MethodPost, "/decisions/migration/apply", bytes.NewReader(body))
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("apply status = %d: %s", w.Code, w.Body.String())
	}
	var applied decisionmigration.ApplyResult
	if err := json.Unmarshal(w.Body.Bytes(), &applied); err != nil || len(applied.Results) != 1 || applied.Results[0].DecisionID == "" {
		t.Fatalf("apply = %+v err=%v", applied, err)
	}
	decision, _ := store.Decisions.Get(applied.Results[0].DecisionID)
	if decision.Status != models.DecisionStatusDraft {
		t.Fatalf("migrated decision status = %q", decision.Status)
	}

	req = httptest.NewRequest(http.MethodPost, "/decisions/migration/"+memoryID+"/rollback", nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("rollback status = %d: %s", w.Code, w.Body.String())
	}
	var rolledBack decisionmigration.RollbackResult
	if err := json.Unmarshal(w.Body.Bytes(), &rolledBack); err != nil || rolledBack.State != decisionmigration.JournalRolledBack {
		t.Fatalf("rollback = %+v err=%v", rolledBack, err)
	}
	if len(sse.events) != 2 {
		t.Fatalf("migration SSE events = %d, want 2", len(sse.events))
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
