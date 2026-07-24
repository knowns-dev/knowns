package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

func TestSearchRoute_ModeHybridKeepsKeywordOnlyCompatibility(t *testing.T) {
	store := newSearchRouteTestStore(t)
	r := chi.NewRouter()
	(&SearchRoutes{store: store}).Register(r)

	req := httptest.NewRequest("GET", "/search?q=retrieval+foundation&mode=hybrid&limit=5", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("GET /search status = %d, want 200", w.Code)
	}

	var resp struct {
		Tasks     []models.SearchResult `json:"tasks"`
		Docs      []models.SearchResult `json:"docs"`
		Memories  []models.SearchResult `json:"memories"`
		Decisions []models.SearchResult `json:"decisions"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(resp.Docs) == 0 {
		t.Fatal("expected doc search results")
	}
	if len(resp.Memories) == 0 {
		t.Fatal("expected memory search results")
	}
	if len(resp.Decisions) == 0 {
		t.Fatal("expected decision search results")
	}
	for _, result := range append(append(append(resp.Docs, resp.Tasks...), resp.Memories...), resp.Decisions...) {
		if strings.Join(result.MatchedBy, ",") != "keyword" {
			t.Fatalf("HTTP /search MatchedBy = %v, want keyword", result.MatchedBy)
		}
	}
	for _, result := range resp.Tasks {
		if result.Type != "task" {
			t.Fatalf("tasks result type = %q, want task", result.Type)
		}
	}
	for _, result := range resp.Memories {
		if result.Type != "memory" {
			t.Fatalf("memories result type = %q, want memory", result.Type)
		}
	}
	for _, result := range resp.Decisions {
		if result.Type != "decision" {
			t.Fatalf("decisions result type = %q, want decision", result.Type)
		}
	}
}

func TestRetrieveRoute_ReturnsCandidatesAndContextPack(t *testing.T) {
	store := newSearchRouteTestStore(t)
	r := chi.NewRouter()
	(&SearchRoutes{store: store}).Register(r)

	req := httptest.NewRequest("GET", "/retrieve?q=retrieval+foundation&sourceType=doc&sourceType=task&sourceType=memory&expandReferences=true", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("GET /retrieve status = %d, want 200", w.Code)
	}

	var resp models.RetrievalResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(resp.Candidates) == 0 {
		t.Fatal("expected retrieval candidates")
	}
	if len(resp.ContextPack.Items) == 0 {
		t.Fatal("expected context pack items")
	}
	if resp.Candidates[0].Type != "doc" {
		t.Fatalf("first candidate type = %q, want doc", resp.Candidates[0].Type)
	}
}

func newSearchRouteTestStore(t *testing.T) *storage.Store {
	t.Helper()
	root := filepath.Join(t.TempDir(), ".knowns")
	store := storage.NewStore(root)
	if err := store.Init("search-route-test"); err != nil {
		t.Fatalf("Init store: %v", err)
	}
	now := time.Now().UTC()

	if err := store.Docs.Create(&models.Doc{
		Path:        "guides/retrieval-foundation",
		Title:       "Retrieval Foundation",
		Description: "Doc-first retrieval foundation guide",
		Content:     "This doc explains the retrieval foundation. It references @task-rag001 and @memory-mem001.",
		Tags:        []string{"rag", "retrieval"},
		CreatedAt:   now,
		UpdatedAt:   now,
	}); err != nil {
		t.Fatalf("create doc: %v", err)
	}
	if err := store.Tasks.Create(&models.Task{
		ID:          "rag001",
		Title:       "Implement retrieval foundation task",
		Description: "Task details for retrieval foundation",
		Status:      "todo",
		Priority:    "high",
		Labels:      []string{"rag", "retrieval"},
		CreatedAt:   now,
		UpdatedAt:   now,
	}); err != nil {
		t.Fatalf("create task: %v", err)
	}
	if err := store.Memory.Create(&models.MemoryEntry{
		ID:        "mem001",
		Title:     "Retrieval preference",
		Layer:     models.MemoryLayerProject,
		Category:  "pattern",
		Content:   "Memories support retrieval foundation context.",
		Tags:      []string{"rag", "retrieval"},
		CreatedAt: now,
		UpdatedAt: now,
	}); err != nil {
		t.Fatalf("create memory: %v", err)
	}
	verifiedAt := now
	if err := store.Decisions.Create(&models.DecisionEntry{
		ID:           "20260723-1200-use-retrieval-foundation",
		Title:        "Use retrieval foundation",
		Status:       models.DecisionStatusAccepted,
		VerifiedAt:   &verifiedAt,
		Verification: []string{"task:@task-rag001:done"},
		Sources:      []string{"@doc/guides/retrieval-foundation"},
		Decision:     "Use the retrieval foundation for project search.",
		CreatedAt:    now,
		UpdatedAt:    now,
	}, storage.DecisionCreateOptions{Now: now}); err != nil {
		t.Fatalf("create decision: %v", err)
	}

	return store
}
