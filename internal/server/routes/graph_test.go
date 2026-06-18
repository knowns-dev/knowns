package routes

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

func TestCodeGraphRouteRemoved(t *testing.T) {
	store := newGraphRouteTestStore(t)
	r := chi.NewRouter()
	(&GraphRoutes{store: store}).Register(r)

	req := httptest.NewRequest(http.MethodGet, "/graph/code", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("GET /graph/code status = %d, want 404", w.Code)
	}
}

func newGraphRouteTestStore(t *testing.T) *storage.Store {
	t.Helper()
	root := filepath.Join(t.TempDir(), ".knowns")
	store := storage.NewStore(root)
	if err := store.Init("graph-route-test"); err != nil {
		t.Fatalf("Init store: %v", err)
	}
	return store
}

func TestExtractMentions_UsesSemanticRelations(t *testing.T) {
	store := newGraphRouteTestStore(t)
	seedSemanticGraphData(t, store)
	routes := &GraphRoutes{store: store}
	edges := routes.extractMentions(
		"doc:guides/source",
		"See @task/rag001{implements}, @memory-mem001, @decision/20260618-1024-use-qdrant-as-default-vector-db, and @doc/guides/source{related}.",
	)

	if len(edges) != 3 {
		t.Fatalf("edge count = %d, want 3", len(edges))
	}
	if edges[0].Type != "implements" {
		t.Fatalf("first edge type = %q, want implements", edges[0].Type)
	}
	if edges[1].Type != models.SemanticReferenceRelationReferences {
		t.Fatalf("second edge type = %q, want references", edges[1].Type)
	}
	if raw, _ := edges[0].Data["raw"].(string); raw != "@task/rag001{implements}" {
		t.Fatalf("raw edge data = %q, want semantic ref", raw)
	}
	if edges[2].Target != "decision:20260618-1024-use-qdrant-as-default-vector-db" {
		t.Fatalf("decision edge target = %q", edges[2].Target)
	}
}

func TestExtractMentions_ResolvesMemoryTitleSlug(t *testing.T) {
	store := newGraphRouteTestStore(t)
	seedSemanticGraphData(t, store)
	routes := &GraphRoutes{store: store}
	edges := routes.extractMentions("task:rag001", "Follow @memory-security-pattern{follows} for details.")

	if len(edges) != 1 {
		t.Fatalf("edge count = %d, want 1", len(edges))
	}
	if edges[0].Type != "follows" {
		t.Fatalf("edge type = %q, want follows", edges[0].Type)
	}
	if edges[0].Target != "memory:mem001" {
		t.Fatalf("edge target = %q, want memory:mem001", edges[0].Target)
	}
}

func seedSemanticGraphData(t *testing.T, store *storage.Store) {
	t.Helper()
	if err := store.Tasks.Create(&models.Task{ID: "rag001", Title: "Runtime Task", Status: "todo", Priority: "medium"}); err != nil {
		t.Fatalf("create task: %v", err)
	}
	if err := store.Docs.Create(&models.Doc{Path: "guides/source", Title: "Source Guide"}); err != nil {
		t.Fatalf("create doc: %v", err)
	}
	if err := store.Memory.Create(&models.MemoryEntry{ID: "mem001", Title: "Security Pattern", Layer: models.MemoryLayerProject, Category: "pattern"}); err != nil {
		t.Fatalf("create memory: %v", err)
	}
	if err := store.Decisions.Create(&models.DecisionEntry{
		ID:      "20260618-1024-use-qdrant-as-default-vector-db",
		Title:   "Use Qdrant as default vector DB",
		Status:  models.DecisionStatusAccepted,
		Sources: []string{"@doc/guides/source"},
	}, storage.DecisionCreateOptions{}); err != nil {
		t.Fatalf("create decision: %v", err)
	}
}
