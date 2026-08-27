package search

import (
	"errors"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

// These tests exercise FR-6 / NFR-1 / NFR-6 / Locked Decision D3 of
// specs/2026-08-24/ollama-only-embedding (task OLM-AKEN95): an operational
// embedder-boundary failure must degrade Search to keyword results instead
// of failing it, in both hybrid and semantic mode, while a failure that is
// not at the embedder boundary must still return an error.

// failingQueryEmbedder embeds stubEmbedder and overrides EmbedQuery so tests
// can simulate an unreachable/failing embedder without touching production
// EmbedderProvider implementations.
type failingQueryEmbedder struct {
	stubEmbedder
	queryErr error
}

func (e failingQueryEmbedder) EmbedQuery(text string) ([]float32, error) {
	if e.queryErr != nil {
		return nil, e.queryErr
	}
	return e.stubEmbedder.EmbedQuery(text)
}

// searchErrVectorStore embeds stubVectorStore and implements
// vectorStoreSearchError so tests can simulate a vector store search failure
// surfaced via LastSearchError, independent of Search's return value.
type searchErrVectorStore struct {
	stubVectorStore
	searchErr error
}

func (s *searchErrVectorStore) LastSearchError() error { return s.searchErr }

var _ vectorStoreSearchError = (*searchErrVectorStore)(nil)

// failingLexicalBackend simulates a keyword-search failure unrelated to the
// embedder boundary (e.g. a corrupt index, a malformed query) so tests can
// assert the keyword-fallback logic does not swallow errors indiscriminately.
type failingLexicalBackend struct {
	err error
}

func (b failingLexicalBackend) Search(query string, opts SearchOptions) ([]models.SearchResult, error) {
	return nil, b.err
}

func newEmbedderFallbackTestStore(t *testing.T, taskID, title, description string) *storeAndTask {
	t.Helper()
	store := newSearchTestStore(t)
	now := time.Now().UTC().Truncate(time.Second)
	task := &models.Task{
		ID:          taskID,
		Title:       title,
		Description: description,
		Status:      "todo",
		Priority:    "medium",
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if err := store.Tasks.Create(task); err != nil {
		t.Fatalf("create Task %s: %v", taskID, err)
	}
	return &storeAndTask{store: store, taskID: taskID}
}

type storeAndTask struct {
	store  *storage.Store
	taskID string
}

func TestHybridSearch_EmbedQueryFailureReturnsKeywordResultsNoError(t *testing.T) {
	setup := newEmbedderFallbackTestStore(t, "task1", "embedder fallback needle title", "embedder fallback needle body")
	vecStore := &stubVectorStore{chunks: []ScoredChunk{
		{Chunk: Chunk{ID: "task:task1:chunk:description", Type: ChunkTypeTask, TaskID: "task1", Status: "todo"}, Score: 0.9},
	}}
	embedder := failingQueryEmbedder{queryErr: errors.New("dial tcp 127.0.0.1:11434: connect: connection refused")}
	engine := NewEngine(setup.store, embedder, vecStore)

	results, err := engine.Search(SearchOptions{
		Query: "embedder fallback needle",
		Type:  "task",
		Mode:  string(ModeHybrid),
		Limit: 10,
	})
	if err != nil {
		t.Fatalf("hybrid Search with unreachable embedder returned an error, want keyword fallback: %v", err)
	}
	if !resultIDsEqual(results, []string{setup.taskID}) {
		t.Fatalf("hybrid Search fallback results = %+v, want keyword match for %s", results, setup.taskID)
	}
}

func TestHybridSearch_VectorStoreSearchErrorReturnsKeywordResultsNoError(t *testing.T) {
	setup := newEmbedderFallbackTestStore(t, "task2", "vecstore fallback needle title", "vecstore fallback needle body")
	vecStore := &searchErrVectorStore{
		stubVectorStore: stubVectorStore{chunks: []ScoredChunk{
			{Chunk: Chunk{ID: "task:task2:chunk:description", Type: ChunkTypeTask, TaskID: "task2", Status: "todo"}, Score: 0.9},
		}},
		searchErr: errors.New("qdrant: search rpc failed: context deadline exceeded"),
	}
	engine := NewEngine(setup.store, stubEmbedder{}, vecStore)

	results, err := engine.Search(SearchOptions{
		Query: "vecstore fallback needle",
		Type:  "task",
		Mode:  string(ModeHybrid),
		Limit: 10,
	})
	if err != nil {
		t.Fatalf("hybrid Search with failing vector store returned an error, want keyword fallback: %v", err)
	}
	if !resultIDsEqual(results, []string{setup.taskID}) {
		t.Fatalf("hybrid Search fallback results = %+v, want keyword match for %s", results, setup.taskID)
	}
}

func TestSemanticSearch_EmbedQueryFailureReturnsKeywordResultsNoError(t *testing.T) {
	setup := newEmbedderFallbackTestStore(t, "task3", "semantic fallback needle title", "semantic fallback needle body")
	vecStore := &stubVectorStore{chunks: []ScoredChunk{
		{Chunk: Chunk{ID: "task:task3:chunk:description", Type: ChunkTypeTask, TaskID: "task3", Status: "todo"}, Score: 0.9},
	}}
	// A message that reads like a malformed-request error, not a connectivity
	// error, to confirm the fallback is triggered by classification at the
	// EmbedQuery boundary rather than by matching on error text (NFR-6).
	embedder := failingQueryEmbedder{queryErr: errors.New("400 bad request: invalid embedding input")}
	engine := NewEngine(setup.store, embedder, vecStore)

	results, err := engine.Search(SearchOptions{
		Query: "semantic fallback needle",
		Type:  "task",
		Mode:  string(ModeSemantic),
		Limit: 10,
	})
	if err != nil {
		t.Fatalf("semantic Search with unreachable embedder returned an error, want keyword fallback: %v", err)
	}
	if !resultIDsEqual(results, []string{setup.taskID}) {
		t.Fatalf("semantic Search fallback results = %+v, want keyword match for %s", results, setup.taskID)
	}
}

// TestHybridSearch_NonEmbedderFailurePropagatesError guards the AC-17 /
// NFR-6 boundary from the other direction: a failure that has nothing to do
// with the embedder (here, the keyword leg itself) must still surface as an
// error rather than being silently absorbed by the keyword-fallback logic
// added for the operational case above.
func TestHybridSearch_NonEmbedderFailurePropagatesError(t *testing.T) {
	setup := newEmbedderFallbackTestStore(t, "task4", "propagate needle title", "propagate needle body")
	vecStore := &stubVectorStore{chunks: []ScoredChunk{
		{Chunk: Chunk{ID: "task:task4:chunk:description", Type: ChunkTypeTask, TaskID: "task4", Status: "todo"}, Score: 0.9},
	}}
	engine := NewEngine(setup.store, stubEmbedder{}, vecStore)
	wantErr := errors.New("bm25: corrupt posting list")
	engine.lexicalBackend = failingLexicalBackend{err: wantErr}

	results, err := engine.Search(SearchOptions{
		Query: "propagate needle",
		Type:  "task",
		Mode:  string(ModeHybrid),
		Limit: 10,
	})
	if err == nil {
		t.Fatalf("hybrid Search swallowed a non-embedder failure instead of returning an error; results = %+v", results)
	}
	if !errors.Is(err, wantErr) {
		t.Fatalf("hybrid Search error = %v, want it to wrap %v", err, wantErr)
	}
	if errors.Is(err, errSemanticUnavailable) {
		t.Fatalf("keyword-leg failure must not be classified as an embedder-boundary operational failure")
	}
}

// TestSemanticSearch_NilEmbedderClassifiedOperational is a direct,
// white-box check that the nil-embedder branch — one of the three
// documented embedder-boundary sources — is explicitly marked operational,
// not inferred from text. It calls semanticSearch directly (bypassing
// Search's own auto-downgrade-to-keyword-when-unavailable logic) so the
// branch itself is exercised.
func TestSemanticSearch_NilEmbedderClassifiedOperational(t *testing.T) {
	setup := newEmbedderFallbackTestStore(t, "task5", "unused", "unused")
	engine := NewEngine(setup.store, nil, nil)

	_, err := engine.semanticSearch("query", SearchOptions{Type: "task", Limit: 10})
	if err == nil {
		t.Fatalf("semanticSearch with nil embedder returned no error")
	}
	if !errors.Is(err, errSemanticUnavailable) {
		t.Fatalf("semanticSearch nil-embedder error = %v, want it classified as errSemanticUnavailable", err)
	}
}
