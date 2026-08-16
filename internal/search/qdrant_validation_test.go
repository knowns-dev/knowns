package search

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

func TestValidateQdrantHitPayloadAcceptsCurrentCanonicalDoc(t *testing.T) {
	store := newSearchTestStore(t)
	doc := &models.Doc{Path: "guides/api", Title: "API", Description: "Auth", Content: "current canonical content"}
	if err := store.Docs.Create(doc); err != nil {
		t.Fatalf("create doc: %v", err)
	}
	pointer := validValidationPointer(store.Root)
	payload := QdrantPayloadFromChunk(Chunk{
		ID:       "doc:guides/api:0",
		Type:     ChunkTypeDoc,
		DocPath:  "guides/api",
		Section:  "Auth",
		Position: 1,
	}, contentHash(doc.Title+"\n"+doc.Description+"\n"+doc.Content))

	chunk, result := ValidateQdrantHitPayload(QdrantHitValidationContext{Store: store, Pointer: pointer, ExpectedModel: "gte-small", ExpectedDimensions: 384}, payload)
	if !result.Valid || result.Stale || result.ReindexRecommended {
		t.Fatalf("validation result = %#v, want valid", result)
	}
	if chunk.Content != "" || chunk.DocPath != "guides/api" || chunk.Section != "Auth" {
		t.Fatalf("chunk = %#v, want pointer metadata without content", chunk)
	}
}

func TestValidateQdrantHitPayloadDropsStaleHashMissingSourceAndPointerMismatch(t *testing.T) {
	store := newSearchTestStore(t)
	if err := store.Docs.Create(&models.Doc{Path: "guides/api", Title: "API", Content: "new content"}); err != nil {
		t.Fatalf("create doc: %v", err)
	}
	pointer := validValidationPointer(store.Root)
	pointer.Embedding.Dimensions = 768
	payload := QdrantPayloadFromChunk(Chunk{ID: "doc:guides/api:0", Type: ChunkTypeDoc, DocPath: "guides/api"}, "old-hash")

	_, result := ValidateQdrantHitPayload(QdrantHitValidationContext{Store: store, Pointer: pointer, ExpectedModel: "gte-small", ExpectedDimensions: 384}, payload)
	if result.Valid || !result.Stale || !result.ReindexRecommended {
		t.Fatalf("validation result = %#v, want stale/reindex", result)
	}
	if len(result.Reasons) < 2 {
		t.Fatalf("expected multiple stale reasons, got %#v", result.Reasons)
	}

	missingPayload := QdrantPayloadFromChunk(Chunk{ID: "doc:missing:0", Type: ChunkTypeDoc, DocPath: "missing"}, "hash")
	_, missing := ValidateQdrantHitPayload(QdrantHitValidationContext{Store: store, Pointer: validValidationPointer(store.Root), ExpectedModel: "gte-small", ExpectedDimensions: 384}, missingPayload)
	if missing.Valid || !missing.ReindexRecommended {
		t.Fatalf("missing source validation = %#v, want stale/reindex", missing)
	}
}

func TestQueryValidatedDropsStaleQdrantHits(t *testing.T) {
	store := newSearchTestStore(t)
	doc := &models.Doc{Path: "guides/api", Title: "API", Content: "current"}
	if err := store.Docs.Create(doc); err != nil {
		t.Fatalf("create doc: %v", err)
	}
	validPayload := QdrantPayloadFromChunk(Chunk{ID: "doc:guides/api:0", Type: ChunkTypeDoc, DocPath: "guides/api"}, contentHash(doc.Title+"\n"+doc.Description+"\n"+doc.Content))
	stalePayload := QdrantPayloadFromChunk(Chunk{ID: "doc:guides/api:1", Type: ChunkTypeDoc, DocPath: "guides/api"}, "old-hash")

	srv, _ := newQdrantTestServer(t, func(w http.ResponseWriter, r *http.Request, body map[string]any) {
		if r.Method != http.MethodPost || r.URL.Path != "/collections/kn_test/points/search" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		writeQdrantOK(w, []map[string]any{
			{"score": 0.9, "payload": validPayload},
			{"score": 0.8, "payload": stalePayload},
		})
	})
	client, err := NewQdrantHTTPClient(QdrantClientConfig{URL: srv.URL})
	if err != nil {
		t.Fatalf("NewQdrantHTTPClient: %v", err)
	}
	chunks, summary, err := client.QueryValidated(context.Background(), "kn_test", []float32{0.1, 0.2}, QdrantQueryOptions{TopK: 2}, QdrantHitValidationContext{Store: store, Pointer: validValidationPointer(store.Root), ExpectedModel: "gte-small", ExpectedDimensions: 384})
	if err != nil {
		t.Fatalf("QueryValidated: %v", err)
	}
	if len(chunks) != 1 || chunks[0].ID != "doc:guides/api:0" {
		t.Fatalf("validated chunks = %#v, want only current hit", chunks)
	}
	if summary.Checked != 2 || summary.Dropped != 1 || !summary.ReindexRecommended {
		t.Fatalf("summary = %#v, want one stale drop with reindex recommendation", summary)
	}
}

func TestProductionQdrantVectorStoreSearchUsesValidatedPath(t *testing.T) {
	store := newSearchTestStore(t)
	doc := &models.Doc{Path: "guides/live", Title: "Live", Content: "canonical"}
	if err := store.Docs.Create(doc); err != nil {
		t.Fatal(err)
	}
	stale := QdrantPayloadFromChunk(Chunk{ID: "doc:guides/live:0", Type: ChunkTypeDoc, DocPath: "guides/live"}, "stale-hash")
	srv, _ := newQdrantTestServer(t, func(w http.ResponseWriter, r *http.Request, body map[string]any) {
		writeQdrantOK(w, []map[string]any{{"score": 0.9, "payload": stale}})
	})
	client, err := NewQdrantHTTPClient(QdrantClientConfig{URL: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	vs := &QdrantVectorStore{store: store, client: client, pointer: validValidationPointer(store.Root), model: "gte-small", dims: 384}
	if got := vs.Search([]float32{1}, VectorSearchOpts{TopK: 5}); len(got) != 0 {
		t.Fatalf("stale production hit escaped validation: %#v", got)
	}
	if summary := vs.LastValidation(); summary.Checked != 1 || summary.Dropped != 1 || !summary.ReindexRecommended {
		t.Fatalf("summary=%#v", summary)
	}
}

func validValidationPointer(root string) *QdrantPointer {
	now := time.Now().UTC()
	return &QdrantPointer{
		Backend:        "qdrant",
		CollectionUUID: "8f2c6a7b-91d4-4f6a-b9f7-2ef84d72a9c1",
		CollectionName: CollectionNameFromUUID("8f2c6a7b-91d4-4f6a-b9f7-2ef84d72a9c1"),
		SchemaVersion:  QdrantPointerSchemaVersion,
		ChunkVersion:   ChunkVersion,
		Embedding:      QdrantEmbeddingPointer{Provider: "local", Model: "gte-small", Dimensions: 384, Distance: "cosine"},
		Owner:          QdrantOwnerPointer{StoreRootFingerprint: StoreRootFingerprint(root)},
		LastIndexedAt:  &now,
		ChunkCount:     1,
	}
}
