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
