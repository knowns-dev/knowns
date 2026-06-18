package search

import (
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

func TestBM25TokenizeDeterministicTokenBoundaries(t *testing.T) {
	got := BM25Tokenize("Knowns-go rewrite: init_plan v2")
	want := []string{"knowns", "go", "rewrite", "init", "plan", "v2"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("BM25Tokenize = %#v, want %#v", got, want)
	}
}

func TestBM25LengthNormalizationPrefersFocusedDocument(t *testing.T) {
	shortDoc := lexicalDocFromDoc(&models.Doc{Path: "short", Title: "Short", Content: "needle"})
	longDoc := lexicalDocFromDoc(&models.Doc{Path: "long", Title: "Long", Content: "needle " + strings.Repeat("filler ", 200)})
	corpus := []lexicalDoc{shortDoc, longDoc}
	stats := newBM25CorpusStats(corpus)
	backend := &bm25LexicalBackend{}
	queryTokens := BM25Tokenize("needle")

	shortScore := backend.scoreDocument(shortDoc, "needle", queryTokens, stats)
	longScore := backend.scoreDocument(longDoc, "needle", queryTokens, stats)

	if shortScore.BM25Score <= longScore.BM25Score {
		t.Fatalf("short BM25 score = %.4f, long BM25 score = %.4f; want focused document higher", shortScore.BM25Score, longScore.BM25Score)
	}
}

func TestBM25FieldWeightingAndExactBoosts(t *testing.T) {
	titleDoc := lexicalDocFromDoc(&models.Doc{Path: "title", Title: "Authentication Flow", Content: "overview"})
	contentDoc := lexicalDocFromDoc(&models.Doc{Path: "content", Title: "Overview", Content: "Authentication flow"})
	corpus := []lexicalDoc{titleDoc, contentDoc}
	stats := newBM25CorpusStats(corpus)
	backend := &bm25LexicalBackend{}
	queryTokens := BM25Tokenize("authentication flow")

	titleScore := backend.scoreDocument(titleDoc, "authentication flow", queryTokens, stats)
	contentScore := backend.scoreDocument(contentDoc, "authentication flow", queryTokens, stats)

	if titleScore.FinalScore <= contentScore.FinalScore {
		t.Fatalf("title score = %.4f, content score = %.4f; want weighted title match higher", titleScore.FinalScore, contentScore.FinalScore)
	}
	if !containsKey(titleScore.Boosts, "title_phrase") && !containsKey(titleScore.Boosts, "exact_title") {
		t.Fatalf("expected inspectable title boost, got %+v", titleScore.Boosts)
	}
}

func TestKeywordModeUsesBM25WithoutSemanticAndPreservesResultShape(t *testing.T) {
	store := newSearchTestStore(t)
	now := time.Now().UTC()
	if err := store.Docs.Create(&models.Doc{
		Path:        "specs/semantic-search",
		Title:       "Semantic Search",
		Description: "Specification for semantic search",
		Content:     "Search models and retrieval.",
		Tags:        []string{"spec", "search"},
		CreatedAt:   now,
		UpdatedAt:   now,
	}); err != nil {
		t.Fatalf("create doc: %v", err)
	}
	if err := store.Tasks.Create(&models.Task{
		ID:          "task01",
		Title:       "Semantic search task",
		Description: "Wire keyword search",
		Status:      "todo",
		Priority:    "high",
		Labels:      []string{"search"},
		CreatedAt:   now,
		UpdatedAt:   now,
	}); err != nil {
		t.Fatalf("create task: %v", err)
	}

	engine := NewEngine(store, nil, nil)
	results, err := engine.Search(SearchOptions{Query: "semantic search", Mode: string(ModeKeyword), Limit: 5})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(results) == 0 {
		t.Fatal("expected keyword results without semantic search configured")
	}

	top := results[0]
	if top.Type == "" || top.ID == "" || top.Title == "" || top.Score <= 0 || len(top.MatchedBy) != 1 || top.MatchedBy[0] != "keyword" {
		t.Fatalf("result shape not preserved: %+v", top)
	}
	if top.Type == "doc" && top.Path == "" {
		t.Fatalf("doc path missing from result: %+v", top)
	}
}

func TestBM25SearchSupportsMemoryMetadata(t *testing.T) {
	store := newSearchTestStore(t)
	now := time.Now().UTC()
	if err := store.Memory.Create(&models.MemoryEntry{
		ID:        "mem001",
		Title:     "Decision Memory",
		Layer:     models.MemoryLayerProject,
		Category:  "decision",
		Content:   "Use BM25 for keyword search ranking.",
		Tags:      []string{"search", "bm25"},
		CreatedAt: now,
		UpdatedAt: now,
	}); err != nil {
		t.Fatalf("create memory: %v", err)
	}

	results, err := NewEngine(store, nil, nil).Search(SearchOptions{Query: "decision memory", Type: "memory", Mode: string(ModeKeyword), Limit: 5})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("results = %d, want 1: %+v", len(results), results)
	}
	got := results[0]
	if got.Type != "memory" || got.ID != "mem001" || got.MemoryLayer != models.MemoryLayerProject || got.Category != "decision" || got.MemoryStore == "" {
		t.Fatalf("memory metadata not preserved: %+v", got)
	}
}

func TestMemorySearchAndRetrieveExcludeNonActiveByDefault(t *testing.T) {
	store := newSearchTestStore(t)
	now := time.Now().UTC()
	for _, entry := range []*models.MemoryEntry{
		{ID: "active1", Title: "Active vector memory", Layer: models.MemoryLayerProject, Category: "decision", Content: "Use Qdrant for vector search.", Status: models.MemoryStatusActive, CreatedAt: now, UpdatedAt: now},
		{ID: "proposed1", Title: "Proposed vector memory", Layer: models.MemoryLayerProject, Category: "decision", Content: "Use proposed vector guidance.", Status: models.MemoryStatusProposed, CreatedAt: now, UpdatedAt: now},
		{ID: "merged1", Title: "Merged vector memory", Layer: models.MemoryLayerProject, Category: "decision", Content: "Merged vector guidance.", Status: models.MemoryStatusMerged, MergedInto: "active1", CreatedAt: now, UpdatedAt: now},
	} {
		if err := store.Memory.Create(entry); err != nil {
			t.Fatalf("create memory %s: %v", entry.ID, err)
		}
	}

	engine := NewEngine(store, nil, nil)
	results, err := engine.Search(SearchOptions{Query: "vector", Type: "memory", Mode: string(ModeKeyword), Limit: 10})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(results) != 1 || results[0].ID != "active1" {
		t.Fatalf("default memory search results = %+v, want only active1", results)
	}

	proposed, err := engine.Search(SearchOptions{Query: "vector", Type: "memory", Mode: string(ModeKeyword), Status: models.MemoryStatusProposed, Limit: 10})
	if err != nil {
		t.Fatalf("Search proposed: %v", err)
	}
	if len(proposed) != 1 || proposed[0].ID != "proposed1" {
		t.Fatalf("proposed status search results = %+v", proposed)
	}

	retrieved, err := engine.Retrieve(models.RetrievalOptions{Query: "vector", SourceTypes: []string{"memory"}, Mode: string(ModeKeyword), Limit: 10})
	if err != nil {
		t.Fatalf("Retrieve: %v", err)
	}
	if len(retrieved.Candidates) != 1 || retrieved.Candidates[0].ID != "active1" {
		t.Fatalf("default memory retrieval candidates = %+v, want only active1", retrieved.Candidates)
	}
	historical, err := engine.Search(SearchOptions{Query: "vector", Type: "memory", Mode: string(ModeKeyword), IncludeHistorical: true, Limit: 10})
	if err != nil {
		t.Fatalf("Search historical memories: %v", err)
	}
	if !resultIDsEqual(historical, []string{"active1", "merged1", "proposed1"}) {
		t.Fatalf("historical memory search results = %+v", historical)
	}

	historicalRetrieved, err := engine.Retrieve(models.RetrievalOptions{Query: "vector", SourceTypes: []string{"memory"}, Mode: string(ModeKeyword), IncludeHistorical: true, Limit: 10})
	if err != nil {
		t.Fatalf("Retrieve historical memories: %v", err)
	}
	if !candidateIDsEqual(historicalRetrieved.Candidates, []string{"active1", "merged1", "proposed1"}) {
		t.Fatalf("historical memory retrieval candidates = %+v", historicalRetrieved.Candidates)
	}
	for _, candidate := range historicalRetrieved.Candidates {
		if candidate.Status == "" || candidate.Metadata.Status == "" {
			t.Fatalf("historical memory candidate missing status metadata: %+v", candidate)
		}
	}
}

func TestDecisionSearchAndRetrieveUseCurrentAcceptedByDefault(t *testing.T) {
	store := newSearchTestStore(t)
	now := time.Now().UTC()
	decisions := []*models.DecisionEntry{
		{
			ID:        "20260618-1024-use-qdrant",
			Title:     "Use Qdrant as default vector DB",
			Status:    models.DecisionStatusAccepted,
			Tags:      []string{"vector", "search"},
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
			Tags:         []string{"vector", "search"},
			Decision:     "Use Chroma for vector db search guidance.",
			CreatedAt:    now.Add(-time.Hour),
			UpdatedAt:    now.Add(-time.Hour),
		},
		{
			ID:        "20260618-0800-draft-vector-db",
			Title:     "Draft vector DB option",
			Status:    models.DecisionStatusDraft,
			Tags:      []string{"vector", "search"},
			Decision:  "Draft vector db guidance.",
			CreatedAt: now.Add(-2 * time.Hour),
			UpdatedAt: now.Add(-2 * time.Hour),
		},
	}
	for _, decision := range decisions {
		if err := store.Decisions.Create(decision, storage.DecisionCreateOptions{}); err != nil {
			t.Fatalf("create decision %s: %v", decision.ID, err)
		}
	}

	engine := NewEngine(store, nil, nil)
	results, err := engine.Search(SearchOptions{Query: "vector db", Type: "decision", Mode: string(ModeKeyword), Limit: 10})
	if err != nil {
		t.Fatalf("Search decisions: %v", err)
	}
	if len(results) != 1 || results[0].ID != "20260618-1024-use-qdrant" || results[0].Status != models.DecisionStatusAccepted {
		t.Fatalf("default decision search results = %+v, want current accepted qdrant", results)
	}

	historical, err := engine.Search(SearchOptions{Query: "vector db", Type: "decision", Mode: string(ModeKeyword), IncludeHistorical: true, Limit: 10})
	if err != nil {
		t.Fatalf("Search historical decisions: %v", err)
	}
	if !resultIDsEqual(historical, []string{"20260618-0800-draft-vector-db", "20260618-0900-use-chroma", "20260618-1024-use-qdrant"}) {
		t.Fatalf("historical decision search results = %+v", historical)
	}

	superseded, err := engine.Search(SearchOptions{Query: "vector db", Type: "decision", Mode: string(ModeKeyword), Status: models.DecisionStatusSuperseded, Limit: 10})
	if err != nil {
		t.Fatalf("Search superseded decisions: %v", err)
	}
	if len(superseded) != 1 || superseded[0].ID != "20260618-0900-use-chroma" {
		t.Fatalf("superseded decision search results = %+v", superseded)
	}

	retrieved, err := engine.Retrieve(models.RetrievalOptions{Query: "vector db", SourceTypes: []string{"decision"}, Mode: string(ModeKeyword), Limit: 10})
	if err != nil {
		t.Fatalf("Retrieve decisions: %v", err)
	}
	if len(retrieved.Candidates) != 1 || retrieved.Candidates[0].ID != "20260618-1024-use-qdrant" {
		t.Fatalf("default decision retrieval candidates = %+v", retrieved.Candidates)
	}

	historicalRetrieved, err := engine.Retrieve(models.RetrievalOptions{Query: "vector db", SourceTypes: []string{"decision"}, Mode: string(ModeKeyword), IncludeHistorical: true, Limit: 10})
	if err != nil {
		t.Fatalf("Retrieve historical decisions: %v", err)
	}
	if !candidateIDsEqual(historicalRetrieved.Candidates, []string{"20260618-0800-draft-vector-db", "20260618-0900-use-chroma", "20260618-1024-use-qdrant"}) {
		t.Fatalf("historical decision retrieval candidates = %+v", historicalRetrieved.Candidates)
	}
	for _, candidate := range historicalRetrieved.Candidates {
		if candidate.Status == "" || candidate.Metadata.Status == "" {
			t.Fatalf("historical decision candidate missing status metadata: %+v", candidate)
		}
	}
}

func TestReindexIndexesDecisionChunksWithStatus(t *testing.T) {
	store := newSearchTestStore(t)
	now := time.Now().UTC()
	decision := &models.DecisionEntry{
		ID:        "20260618-1024-use-qdrant",
		Title:     "Use Qdrant as default vector DB",
		Status:    models.DecisionStatusAccepted,
		Tags:      []string{"vector", "search"},
		Sources:   []string{"@doc/specs/2026-06-18/memory-decision-review-ui"},
		Decision:  "Use Qdrant for vector db search guidance.",
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := store.Decisions.Create(decision, storage.DecisionCreateOptions{}); err != nil {
		t.Fatalf("create decision: %v", err)
	}

	vecStore := &recordingVectorStore{hashes: map[string]string{}}
	indexer := NewIndexService(store, stubEmbedder{}, vecStore)
	if err := indexer.Reindex(nil); err != nil {
		t.Fatalf("Reindex: %v", err)
	}

	var found bool
	for _, chunk := range vecStore.chunks {
		if chunk.Type != ChunkTypeDecision {
			continue
		}
		found = true
		if chunk.DecisionID != decision.ID || chunk.Status != models.DecisionStatusAccepted {
			t.Fatalf("decision chunk = %+v, want id/status metadata", chunk)
		}
	}
	if !found {
		t.Fatalf("expected decision chunks, got %+v", vecStore.chunks)
	}
}

func TestSearchWithLexicalBackendComparesHeuristicAndBM25Internally(t *testing.T) {
	store := newSearchTestStore(t)
	now := time.Now().UTC()
	if err := store.Docs.Create(&models.Doc{
		Path:      "specs/rag-retrieval-foundation",
		Title:     "RAG Retrieval Foundation",
		Content:   "Retrieval foundation for docs tasks and memories.",
		CreatedAt: now,
		UpdatedAt: now,
	}); err != nil {
		t.Fatalf("create doc: %v", err)
	}

	for _, backend := range []string{lexicalBackendHeuristic, lexicalBackendBM25} {
		results, err := SearchWithLexicalBackend(store, backend, "rag retrieval foundation", SearchOptions{Limit: 5})
		if err != nil {
			t.Fatalf("SearchWithLexicalBackend(%s): %v", backend, err)
		}
		if len(results) == 0 || results[0].ID != "specs/rag-retrieval-foundation" {
			t.Fatalf("backend %s results = %+v", backend, results)
		}
	}
}

func newSearchTestStore(t *testing.T) *storage.Store {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	root := filepath.Join(t.TempDir(), ".knowns")
	store := storage.NewStore(root)
	if err := store.Init("search-test"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	return store
}

func resultIDsEqual(results []models.SearchResult, want []string) bool {
	got := make([]string, 0, len(results))
	for _, result := range results {
		got = append(got, result.ID)
	}
	return reflect.DeepEqual(sortedStrings(got), sortedStrings(want))
}

func candidateIDsEqual(candidates []models.RetrievalCandidate, want []string) bool {
	got := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		got = append(got, candidate.ID)
	}
	return reflect.DeepEqual(sortedStrings(got), sortedStrings(want))
}

func sortedStrings(values []string) []string {
	cp := append([]string(nil), values...)
	sort.Strings(cp)
	return cp
}

type recordingVectorStore struct {
	chunks []Chunk
	hashes map[string]string
}

func (s *recordingVectorStore) Load() error { return nil }
func (s *recordingVectorStore) Save() error { return nil }
func (s *recordingVectorStore) Clear() error {
	s.chunks = nil
	s.hashes = map[string]string{}
	return nil
}
func (s *recordingVectorStore) AddChunks(chunks []Chunk) {
	s.chunks = append(s.chunks, chunks...)
}
func (s *recordingVectorStore) RemoveByPrefix(prefix string) {
	filtered := s.chunks[:0]
	for _, chunk := range s.chunks {
		if !strings.HasPrefix(chunk.ID, prefix) {
			filtered = append(filtered, chunk)
		}
	}
	s.chunks = filtered
}
func (s *recordingVectorStore) RemoveByIDs(ids []string) {}
func (s *recordingVectorStore) Search([]float32, VectorSearchOpts) []ScoredChunk {
	return nil
}
func (s *recordingVectorStore) Count() int { return len(s.chunks) }
func (s *recordingVectorStore) NeedsRebuild(string) bool {
	return false
}
func (s *recordingVectorStore) Stats() (int, string, time.Time) {
	return len(s.chunks), "stub", time.Time{}
}
func (s *recordingVectorStore) Close() error  { return nil }
func (s *recordingVectorStore) Model() string { return "stub" }
func (s *recordingVectorStore) GetContentHash(sourceID string) string {
	return s.hashes[sourceID]
}
func (s *recordingVectorStore) SetContentHash(sourceID, hash string) {
	if s.hashes == nil {
		s.hashes = map[string]string{}
	}
	s.hashes[sourceID] = hash
}
func (s *recordingVectorStore) DeleteContentHash(sourceID string) {
	delete(s.hashes, sourceID)
}
func (s *recordingVectorStore) ListContentHashes() map[string]string {
	out := make(map[string]string, len(s.hashes))
	for k, v := range s.hashes {
		out[k] = v
	}
	return out
}
