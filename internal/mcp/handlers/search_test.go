package handlers

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/mark3labs/mcp-go/mcp"
)

func TestHandleSearchHybridFallsBackToKeywordCompatibleResults(t *testing.T) {
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("search-mcp-test"); err != nil {
		t.Fatalf("init store: %v", err)
	}

	now := time.Now().UTC()
	if err := store.Docs.Create(&models.Doc{
		Path:        "guides/retrieval-foundation",
		Title:       "Retrieval Foundation",
		Description: "Doc-first retrieval foundation guide",
		Content:     "This doc explains the retrieval foundation.",
		Tags:        []string{"rag", "retrieval"},
		CreatedAt:   now,
		UpdatedAt:   now,
	}); err != nil {
		t.Fatalf("create doc: %v", err)
	}

	result, err := handleSearch(func() *storage.Store { return store }, mcp.CallToolRequest{
		Params: mcp.CallToolParams{Arguments: map[string]any{
			"query": "retrieval foundation",
			"mode":  "hybrid",
			"limit": 5,
		}},
	})
	if err != nil {
		t.Fatalf("handleSearch: %v", err)
	}

	text, ok := result.Content[0].(mcp.TextContent)
	if !ok {
		t.Fatalf("unexpected MCP result content: %#v", result.Content[0])
	}
	var results []models.SearchResult
	if err := json.Unmarshal([]byte(text.Text), &results); err != nil {
		t.Fatalf("decode search result: %v\n%s", err, text.Text)
	}
	if len(results) == 0 {
		t.Fatal("expected MCP search results")
	}
	for _, result := range results {
		if strings.Join(result.MatchedBy, ",") != "keyword" {
			t.Fatalf("MCP MatchedBy = %v, want keyword", result.MatchedBy)
		}
	}
}

func TestHandleSearchAndRetrieveIncludeHistoricalDecisions(t *testing.T) {
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("search-mcp-test"); err != nil {
		t.Fatalf("init store: %v", err)
	}

	now := time.Now().UTC()
	for _, decision := range []*models.DecisionEntry{
		{
			ID:        "20260618-1024-use-qdrant",
			Title:     "Use Qdrant as default vector DB",
			Status:    models.DecisionStatusAccepted,
			Tags:      []string{"vector"},
			Sources:   []string{"@doc/specs/2026-06-18/memory-decision-review-ui"},
			Decision:  "Use Qdrant for vector db search guidance.",
			CreatedAt: now,
			UpdatedAt: now,
		},
		{
			ID:           "20260618-0900-use-chroma",
			Title:        "Use Chroma as vector DB",
			Status:       models.DecisionStatusSuperseded,
			SupersededBy: []string{"20260618-1024-use-qdrant"},
			Tags:         []string{"vector"},
			Decision:     "Use Chroma for vector db search guidance.",
			CreatedAt:    now.Add(-time.Hour),
			UpdatedAt:    now.Add(-time.Hour),
		},
	} {
		if err := store.Decisions.Create(decision, storage.DecisionCreateOptions{}); err != nil {
			t.Fatalf("create decision %s: %v", decision.ID, err)
		}
	}

	searchResult, err := handleSearch(func() *storage.Store { return store }, mcp.CallToolRequest{
		Params: mcp.CallToolParams{Arguments: map[string]any{
			"query":             "vector db",
			"type":              "decision",
			"mode":              "keyword",
			"includeHistorical": true,
			"limit":             10,
		}},
	})
	if err != nil {
		t.Fatalf("handleSearch: %v", err)
	}
	searchText, ok := searchResult.Content[0].(mcp.TextContent)
	if !ok {
		t.Fatalf("unexpected search content: %#v", searchResult.Content[0])
	}
	var results []models.SearchResult
	if err := json.Unmarshal([]byte(searchText.Text), &results); err != nil {
		t.Fatalf("decode search result: %v\n%s", err, searchText.Text)
	}
	if len(results) != 2 {
		t.Fatalf("search results = %+v, want accepted and superseded decisions", results)
	}
	for _, result := range results {
		if result.Status == "" {
			t.Fatalf("search result missing status metadata: %+v", result)
		}
	}

	retrieveResult, err := handleRetrieve(func() *storage.Store { return store }, mcp.CallToolRequest{
		Params: mcp.CallToolParams{Arguments: map[string]any{
			"query":             "vector db",
			"sourceTypes":       []any{"decision"},
			"mode":              "keyword",
			"includeHistorical": true,
			"limit":             10,
		}},
	})
	if err != nil {
		t.Fatalf("handleRetrieve: %v", err)
	}
	retrieveText, ok := retrieveResult.Content[0].(mcp.TextContent)
	if !ok {
		t.Fatalf("unexpected retrieve content: %#v", retrieveResult.Content[0])
	}
	var response models.RetrievalResponse
	if err := json.Unmarshal([]byte(retrieveText.Text), &response); err != nil {
		t.Fatalf("decode retrieve response: %v\n%s", err, retrieveText.Text)
	}
	if len(response.Candidates) != 2 {
		t.Fatalf("retrieve candidates = %+v, want accepted and superseded decisions", response.Candidates)
	}
	for _, candidate := range response.Candidates {
		if candidate.Status == "" || candidate.Metadata.Status == "" {
			t.Fatalf("retrieve candidate missing status metadata: %+v", candidate)
		}
	}
}

func TestResolveReferenceJSON(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	root := filepath.Join(t.TempDir(), ".knowns")
	store := storage.NewStore(root)
	if err := store.Init("resolve-mcp-test"); err != nil {
		t.Fatalf("init store: %v", err)
	}

	now := time.Now().UTC()
	if err := store.Docs.Create(&models.Doc{
		Path:      "guides/setup",
		Title:     "Setup Guide",
		Tags:      []string{"guide"},
		Content:   "Body",
		CreatedAt: now,
		UpdatedAt: now,
	}); err != nil {
		t.Fatalf("create doc: %v", err)
	}

	out, err := resolveReferenceJSON(store, "@doc/guides/setup:10-12{implements}")
	if err != nil {
		t.Fatalf("resolveReferenceJSON returned error: %v", err)
	}

	var resolution models.SemanticResolution
	if err := json.Unmarshal([]byte(out), &resolution); err != nil {
		t.Fatalf("unmarshal output: %v\n%s", err, out)
	}
	if !resolution.Found || resolution.Entity == nil {
		t.Fatal("expected resolved entity")
	}
	if resolution.Entity.Type != "doc" || resolution.Entity.Path != "guides/setup" {
		t.Fatalf("unexpected entity: %+v", resolution.Entity)
	}
	if resolution.Reference.Relation != "implements" {
		t.Fatalf("relation = %q", resolution.Reference.Relation)
	}
	if resolution.Reference.Fragment == nil || resolution.Reference.Fragment.RangeStart != 10 || resolution.Reference.Fragment.RangeEnd != 12 {
		t.Fatalf("unexpected fragment: %+v", resolution.Reference.Fragment)
	}
}

func TestResolveReferenceJSONInvalid(t *testing.T) {
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if _, err := resolveReferenceJSON(store, "bad-ref"); err == nil {
		t.Fatal("expected invalid ref error")
	}
}
