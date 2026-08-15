package search

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

const EnvQdrantAPIKey = "KNOWNS_QDRANT_API_KEY"

var openQdrantVectorStoreOverride func(*storage.Store, string, int) (VectorStore, error)

// QdrantVectorStore is the production read path. All queries pass through
// QueryValidated before Engine assembles canonical snippets/context.
type QdrantVectorStore struct {
	store          *storage.Store
	client         QdrantClient
	pointer        *QdrantPointer
	model          string
	dims           int
	lastValidation QdrantHitValidationSummary
	lastSearchErr  error
}

func OpenQdrantVectorStore(store *storage.Store, model string, dims int) (*QdrantVectorStore, error) {
	if store == nil {
		return nil, ErrSemanticNotConfigured
	}
	pointer, err := LoadQdrantPointer(store.Root)
	if err != nil {
		return nil, err
	}
	if pointer == nil {
		return nil, fmt.Errorf("qdrant pointer missing; run: knowns search index --wait")
	}
	client, err := qdrantClientForStore(store)
	if err != nil {
		return nil, err
	}
	return &QdrantVectorStore{store: store, client: client, pointer: pointer, model: model, dims: dims}, nil
}

func qdrantClientForStore(store *storage.Store) (QdrantClient, error) {
	res := resolveEffectiveVectorStore(store)
	endpoint := strings.TrimSpace(res.ExternalURL)
	if res.Mode == models.SemanticVectorStoreModeManaged {
		endpoint = "http://127.0.0.1:6333"
	}
	return NewQdrantHTTPClient(QdrantClientConfig{URL: endpoint, APIKey: os.Getenv(EnvQdrantAPIKey)})
}

// NewConfiguredQdrantClient resolves the managed/external endpoint without
// exposing or persisting its API key.
func NewConfiguredQdrantClient(store *storage.Store) (QdrantClient, error) {
	return qdrantClientForStore(store)
}

// PurgeConfiguredQdrantStore is the explicit privacy/hard-purge boundary.
func PurgeConfiguredQdrantStore(ctx context.Context, store *storage.Store) ([]string, error) {
	client, err := qdrantClientForStore(store)
	if err != nil {
		return nil, err
	}
	return PurgeQdrantCollections(ctx, store.Root, client)
}

func (s *QdrantVectorStore) Load() error { return nil }
func (s *QdrantVectorStore) Save() error { return nil }
func (s *QdrantVectorStore) Clear() error {
	return fmt.Errorf("Qdrant mutation requires a generation rebuild")
}

// Incremental mutations are owned by ExecuteQdrantReconciliation, which
// carries durable lifecycle proof, exact source deletion, retries, and the
// per-entity watermark. The VectorStore interface cannot return mutation
// errors, so these methods intentionally fail closed rather than performing an
// untracked backend write.
func (s *QdrantVectorStore) AddChunks([]Chunk)     {}
func (s *QdrantVectorStore) RemoveByPrefix(string) {}
func (s *QdrantVectorStore) RemoveByIDs([]string)  {}
func (s *QdrantVectorStore) Search(vec []float32, opts VectorSearchOpts) []ScoredChunk {
	q := QdrantQueryOptions{TopK: opts.TopK, Threshold: opts.Threshold, ChunkType: opts.ChunkType}
	hits, summary, err := s.client.QueryValidated(context.Background(), s.pointer.CollectionName, vec, q, QdrantHitValidationContext{Store: s.store, Pointer: s.pointer, ExpectedModel: s.model, ExpectedDimensions: s.dims})
	s.lastValidation = summary
	s.lastSearchErr = err
	if err != nil {
		return nil
	}
	return hits
}
func (s *QdrantVectorStore) Count() int {
	if s.pointer == nil {
		return 0
	}
	return int(s.pointer.ChunkCount)
}
func (s *QdrantVectorStore) NeedsRebuild(model string) bool {
	return s.pointer == nil || s.pointer.Embedding.Model != model || s.pointer.Embedding.Dimensions != s.dims || s.pointer.ChunkVersion != ChunkVersion
}
func (s *QdrantVectorStore) Stats() (int, string, time.Time) {
	if s.pointer == nil {
		return 0, s.model, time.Time{}
	}
	var at time.Time
	if s.pointer.LastIndexedAt != nil {
		at = *s.pointer.LastIndexedAt
	}
	return int(s.pointer.ChunkCount), s.pointer.Embedding.Model, at
}
func (s *QdrantVectorStore) Close() error                               { return nil }
func (s *QdrantVectorStore) Model() string                              { return s.model }
func (s *QdrantVectorStore) GetContentHash(string) string               { return "" }
func (s *QdrantVectorStore) SetContentHash(string, string)              {}
func (s *QdrantVectorStore) DeleteContentHash(string)                   {}
func (s *QdrantVectorStore) ListContentHashes() map[string]string       { return nil }
func (s *QdrantVectorStore) LastValidation() QdrantHitValidationSummary { return s.lastValidation }
func (s *QdrantVectorStore) LastSearchError() error                     { return s.lastSearchErr }

var _ VectorStore = (*QdrantVectorStore)(nil)
