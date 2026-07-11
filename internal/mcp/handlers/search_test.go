package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/search"
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
		if result.Runtime == nil || !result.Runtime.Degraded {
			t.Fatalf("MCP runtime metadata = %+v, want degraded metadata on fallback result", result.Runtime)
		}
	}
}

func TestHandleSearchConcurrentHybridUsesSingleSemanticRuntimeEntry(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	search.DefaultSemanticRuntime().Close()
	t.Cleanup(search.DefaultSemanticRuntime().Close)
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("search-mcp-runtime-test"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	project, err := store.Config.Load()
	if err != nil {
		t.Fatalf("load project config: %v", err)
	}
	project.Settings.SemanticSearch = &models.SemanticSearchSettings{
		Enabled:    true,
		Provider:   "api",
		Model:      "api-model",
		Dimensions: 384,
	}
	if err := store.Config.Save(project); err != nil {
		t.Fatalf("save project config: %v", err)
	}
	apiBase, apiCalls := startMCPEmbeddingAPIServer(t)
	saveMCPEmbeddingSettings(t, apiBase)

	now := time.Now().UTC()
	if err := store.Docs.Create(&models.Doc{
		Path:      "guides/runtime-owner",
		Title:     "Runtime Owner",
		Content:   "semantic runtime owner keyword fallback",
		CreatedAt: now,
		UpdatedAt: now,
	}); err != nil {
		t.Fatalf("create doc: %v", err)
	}
	seedMCPSemanticDocIndex(t, store)

	const workers = 2
	start := make(chan struct{})
	errs := make(chan error, workers)
	var wg sync.WaitGroup
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			result, err := handleSearch(func() *storage.Store { return store }, mcp.CallToolRequest{
				Params: mcp.CallToolParams{Arguments: map[string]any{
					"query": "runtime owner",
					"mode":  "hybrid",
					"limit": 5,
				}},
			})
			if err != nil {
				errs <- err
				return
			}
			text, ok := result.Content[0].(mcp.TextContent)
			if !ok {
				errs <- errUnexpectedMCPContent
				return
			}
			var results []models.SearchResult
			if err := json.Unmarshal([]byte(text.Text), &results); err != nil {
				errs <- err
				return
			}
			if len(results) == 0 {
				errs <- errExpectedSearchResults
				return
			}
			errs <- nil
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent MCP search: %v", err)
		}
	}
	status := search.DefaultSemanticRuntime().Status()
	if len(status.Entries) != 1 {
		t.Fatalf("semantic runtime entries = %+v, want exactly one shared entry", status.Entries)
	}
	if !status.Entries[0].Loaded || status.Entries[0].Provider != "api" {
		t.Fatalf("semantic runtime entry = %+v, want loaded api entry", status.Entries[0])
	}
	if apiCalls.Load() == 0 {
		t.Fatalf("expected semantic query embedding API calls")
	}
}

func TestHandleRetrieveHybridRuntimeMetadataIsAdditive(t *testing.T) {
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("retrieve-mcp-test"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	now := time.Now().UTC()
	if err := store.Docs.Create(&models.Doc{
		Path:      "guides/additive-runtime",
		Title:     "Additive Runtime",
		Content:   "runtime metadata remains additive for retrieve clients",
		CreatedAt: now,
		UpdatedAt: now,
	}); err != nil {
		t.Fatalf("create doc: %v", err)
	}

	result, err := handleRetrieve(func() *storage.Store { return store }, mcp.CallToolRequest{
		Params: mcp.CallToolParams{Arguments: map[string]any{
			"query": "runtime metadata",
			"mode":  "hybrid",
			"limit": 5,
		}},
	})
	if err != nil {
		t.Fatalf("handleRetrieve: %v", err)
	}
	text, ok := result.Content[0].(mcp.TextContent)
	if !ok {
		t.Fatalf("unexpected retrieve content: %#v", result.Content[0])
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal([]byte(text.Text), &raw); err != nil {
		t.Fatalf("decode retrieve raw response: %v\n%s", err, text.Text)
	}
	if _, ok := raw["_runtime"]; !ok {
		t.Fatalf("retrieve response missing additive _runtime metadata: %s", text.Text)
	}
	var response models.RetrievalResponse
	if err := json.Unmarshal([]byte(text.Text), &response); err != nil {
		t.Fatalf("decode retrieve compatibility response: %v\n%s", err, text.Text)
	}
	if len(response.Candidates) == 0 {
		t.Fatalf("expected retrieve candidates")
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

var (
	errUnexpectedMCPContent  = simpleSearchTestError("unexpected MCP content")
	errExpectedSearchResults = simpleSearchTestError("expected search results")
)

type simpleSearchTestError string

func (e simpleSearchTestError) Error() string {
	return string(e)
}

func startMCPEmbeddingAPIServer(t *testing.T) (string, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		embedding := make([]float32, 384)
		embedding[0] = 1
		resp := map[string]any{
			"object": "list",
			"model":  "text-embedding-test",
			"data": []map[string]any{{
				"object":    "embedding",
				"index":     0,
				"embedding": embedding,
			}},
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(server.Close)
	return server.URL, &calls
}

func seedMCPSemanticDocIndex(t *testing.T, store *storage.Store) {
	t.Helper()
	vecStore := search.NewSQLiteVectorStore(filepath.Join(store.Root, ".search"), "api-model", 384)
	if err := vecStore.Load(); err != nil {
		t.Fatalf("load vector store: %v", err)
	}
	defer vecStore.Close()
	embedding := make([]float32, 384)
	embedding[0] = 1
	vecStore.AddChunks([]search.Chunk{{
		ID:         "doc:guides/runtime-owner:chunk:1",
		Type:       search.ChunkTypeDoc,
		Content:    "semantic runtime owner keyword fallback",
		TokenCount: 5,
		Embedding:  embedding,
		DocPath:    "guides/runtime-owner",
		Position:   1,
	}})
	if err := vecStore.Save(); err != nil {
		t.Fatalf("save vector store: %v", err)
	}
}

func saveMCPEmbeddingSettings(t *testing.T, apiBase string) {
	t.Helper()
	settings := &storage.EmbeddingSettings{
		Providers: map[string]storage.EmbeddingProvider{
			"test-provider": {
				Name:      "test-provider",
				APIBase:   apiBase,
				APIKey:    "secret-for-mcp-test",
				Timeout:   1,
				BatchSize: 2,
			},
		},
		Models: map[string]storage.EmbeddingModel{
			"api-model": {
				Provider:   "test-provider",
				Model:      "text-embedding-test",
				Dimensions: 384,
			},
		},
	}
	if err := storage.NewEmbeddingSettingsStore().Save(settings); err != nil {
		t.Fatalf("save embedding settings: %v", err)
	}
}
