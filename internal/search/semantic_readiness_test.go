package search

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/runtimequeue"
	"github.com/howznguyen/knowns/internal/storage"
)

// configureSemanticStore enables semantic search on a fresh test store with the
// given vector store settings (nil keeps the resolved default).
func configureSemanticStore(t *testing.T, vs *models.SemanticVectorStoreSettings) *storage.Store {
	t.Helper()
	store := newSearchTestStore(t)
	project, err := store.Config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	project.Settings.SemanticSearch = &models.SemanticSearchSettings{
		Enabled:     true,
		Provider:    "local",
		Model:       "gte-small",
		Dimensions:  384,
		VectorStore: vs,
	}
	if err := store.Config.Save(project); err != nil {
		t.Fatalf("save config: %v", err)
	}
	return store
}

func TestResolveSemanticIndexReadinessDisabledNotConfigured(t *testing.T) {
	store := newSearchTestStore(t)
	r := ResolveSemanticIndexReadiness(store)
	if r.Enabled {
		t.Fatalf("enabled = true, want false for unconfigured store")
	}
	if r.OptedOut {
		t.Fatalf("optedOut = true, want false for unconfigured store")
	}
	if r.Ready || r.Stale || r.Degraded {
		t.Fatalf("ready/stale/degraded set for disabled store: %+v", r)
	}
	if r.Backend != models.SemanticVectorBackendQdrant {
		t.Fatalf("backend = %q, want default %q", r.Backend, models.SemanticVectorBackendQdrant)
	}
	if !strings.Contains(r.Reason, "not configured") {
		t.Fatalf("reason = %q, want not-configured explanation", r.Reason)
	}
}

func TestResolveSemanticIndexReadinessExplicitOptOut(t *testing.T) {
	store := newSearchTestStore(t)
	project, err := store.Config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	project.Settings.SemanticSearch = &models.SemanticSearchSettings{Enabled: false}
	if err := store.Config.Save(project); err != nil {
		t.Fatalf("save config: %v", err)
	}
	r := ResolveSemanticIndexReadiness(store)
	if r.Enabled {
		t.Fatalf("enabled = true, want false")
	}
	if !r.OptedOut {
		t.Fatalf("optedOut = false, want true for explicit opt-out")
	}
	if !strings.Contains(r.Reason, "disabled") {
		t.Fatalf("reason = %q, want disabled explanation", r.Reason)
	}
}

func TestResolveSemanticIndexReadinessBackendNone(t *testing.T) {
	store := configureSemanticStore(t, &models.SemanticVectorStoreSettings{Backend: models.SemanticVectorBackendNone})
	r := ResolveSemanticIndexReadiness(store)
	if r.Enabled {
		t.Fatalf("enabled = true, want false for backend none")
	}
	if !r.OptedOut {
		t.Fatalf("optedOut = false, want true for backend none")
	}
	if r.Backend != models.SemanticVectorBackendNone {
		t.Fatalf("backend = %q, want none", r.Backend)
	}
	if !strings.Contains(r.Reason, "disabled") {
		t.Fatalf("reason = %q, want disabled explanation", r.Reason)
	}
}

func TestResolveSemanticIndexReadinessSQLiteLegacyReadyViaQdrantDefault(t *testing.T) {
	store := configureSemanticStore(t, nil) // backend resolves to qdrant default
	seedRuntimeSearchIndex(t, store.Root, "gte-small", 384)
	r := ResolveSemanticIndexReadiness(store)
	if r.Backend != models.SemanticVectorBackendQdrant {
		t.Fatalf("backend = %q, want resolved default %q", r.Backend, models.SemanticVectorBackendQdrant)
	}
	if !r.Ready {
		t.Fatalf("ready = false, want true via legacy sqlite fallback: %+v", r)
	}
	if !r.Degraded {
		t.Fatalf("degraded = false, want true during migration window: %+v", r)
	}
	if r.Model != "gte-small" || r.ChunkCount <= 0 {
		t.Fatalf("model/chunkCount not surfaced: %+v", r)
	}
	if !strings.Contains(r.Reason, "legacy sqlite") {
		t.Fatalf("reason = %q, want migration fallback explanation", r.Reason)
	}
}

func TestResolveSemanticIndexReadinessSQLiteBackendExplicit(t *testing.T) {
	store := configureSemanticStore(t, &models.SemanticVectorStoreSettings{Backend: models.SemanticVectorBackendSQLite})
	seedRuntimeSearchIndex(t, store.Root, "gte-small", 384)
	r := ResolveSemanticIndexReadiness(store)
	if r.Backend != models.SemanticVectorBackendSQLite {
		t.Fatalf("backend = %q, want sqlite", r.Backend)
	}
	if !r.Ready {
		t.Fatalf("ready = false, want true for fresh sqlite index: %+v", r)
	}
	if r.Stale || r.Degraded {
		t.Fatalf("stale/degraded set for fresh sqlite index: %+v", r)
	}
	if r.Model != "gte-small" || r.ChunkCount <= 0 {
		t.Fatalf("model/chunkCount not surfaced: %+v", r)
	}
}

func TestResolveSemanticIndexReadinessSQLiteStaleModel(t *testing.T) {
	store := configureSemanticStore(t, &models.SemanticVectorStoreSettings{Backend: models.SemanticVectorBackendSQLite})
	seedRuntimeSearchIndex(t, store.Root, "old-model", 384)
	r := ResolveSemanticIndexReadiness(store)
	if r.Ready {
		t.Fatalf("ready = true, want false for stale sqlite index")
	}
	if !r.Stale {
		t.Fatalf("stale = false, want true for model mismatch: %+v", r)
	}
	if !strings.Contains(r.Reason, "old-model") {
		t.Fatalf("reason = %q, want stale model explanation", r.Reason)
	}
}

func TestResolveSemanticIndexReadinessSQLiteMissingIndex(t *testing.T) {
	store := configureSemanticStore(t, &models.SemanticVectorStoreSettings{Backend: models.SemanticVectorBackendSQLite})
	r := ResolveSemanticIndexReadiness(store)
	if r.Ready {
		t.Fatalf("ready = true, want false with no sqlite index")
	}
	if !r.Degraded {
		t.Fatalf("degraded = false, want true with no sqlite index")
	}
}

func writeReadyQdrantPointer(t *testing.T, store *storage.Store) {
	t.Helper()
	now := time.Date(2026, 8, 13, 12, 0, 0, 0, time.UTC)
	p := &QdrantPointer{
		Backend:        models.SemanticVectorBackendQdrant,
		CollectionUUID: "8f2c6a7b-91d4-4f6a-b9f7-2ef84d72a9c1",
		SchemaVersion:  QdrantPointerSchemaVersion,
		ChunkVersion:   ChunkVersion,
		Embedding: QdrantEmbeddingPointer{
			Provider:   "local",
			Model:      "gte-small",
			Dimensions: 384,
		},
		Owner: QdrantOwnerPointer{
			ProjectID:            "semantic-readiness-test",
			StoreRootFingerprint: StoreRootFingerprint(store.Root),
		},
		LastIndexedAt: &now,
		ChunkCount:    42,
	}
	if err := SaveQdrantPointer(store.Root, p); err != nil {
		t.Fatalf("save qdrant pointer: %v", err)
	}
}

func TestResolveSemanticIndexReadinessQdrantPointerReady(t *testing.T) {
	store := configureSemanticStore(t, nil)
	writeReadyQdrantPointer(t, store)
	r := ResolveSemanticIndexReadiness(store)
	if r.Backend != models.SemanticVectorBackendQdrant {
		t.Fatalf("backend = %q, want qdrant", r.Backend)
	}
	if !r.Ready {
		t.Fatalf("ready = false, want true for valid pointer: %+v", r)
	}
	if r.Stale || r.Degraded {
		t.Fatalf("stale/degraded set for valid pointer: %+v", r)
	}
	if r.Model != "gte-small" || r.Dimensions != 384 || r.ChunkVersion != ChunkVersion || r.ChunkCount != 42 {
		t.Fatalf("pointer metadata not surfaced: %+v", r)
	}
	if r.IndexedAt == nil || !r.IndexedAt.Equal(time.Date(2026, 8, 13, 12, 0, 0, 0, time.UTC)) {
		t.Fatalf("indexedAt = %v, want pointer lastIndexedAt", r.IndexedAt)
	}
}

func TestResolveSemanticIndexReadinessQdrantPointerMissing(t *testing.T) {
	store := configureSemanticStore(t, nil)
	if err := markQdrantIntentPending(store.Root, runtimequeue.QdrantIntent{EntityType: "task", EntityID: "pending", Revision: 1, Operation: "update", CanonicalHash: "pending-hash", Path: "tasks/pending.md", BatchID: "public-hook"}); err != nil {
		t.Fatal(err)
	}
	r := ResolveSemanticIndexReadiness(store)
	if r.Ready {
		t.Fatalf("ready = true, want false with no pointer and no sqlite index")
	}
	if !r.Degraded {
		t.Fatalf("degraded = false, want true with no pointer and no sqlite index")
	}
	if !strings.Contains(r.Reason, "no qdrant pointer") {
		t.Fatalf("reason = %q, want missing pointer explanation", r.Reason)
	}
	if r.EntityStaleCount != 1 || len(r.Entities) != 1 || r.Entities[0].CanonicalHash != "pending-hash" || !r.Entities[0].Stale {
		t.Fatalf("pointer-missing stale entity readiness lost: %+v", r)
	}
}

func TestResolveSemanticIndexReadinessQdrantOwnerMismatch(t *testing.T) {
	store := configureSemanticStore(t, nil)
	p := &QdrantPointer{
		Backend:        models.SemanticVectorBackendQdrant,
		CollectionUUID: "8f2c6a7b-91d4-4f6a-b9f7-2ef84d72a9c1",
		ChunkVersion:   ChunkVersion,
		Embedding:      QdrantEmbeddingPointer{Model: "gte-small", Dimensions: 384},
		Owner:          QdrantOwnerPointer{StoreRootFingerprint: StoreRootFingerprint("/some/other/root")},
		ChunkCount:     10,
	}
	if err := SaveQdrantPointer(store.Root, p); err != nil {
		t.Fatalf("save qdrant pointer: %v", err)
	}
	r := ResolveSemanticIndexReadiness(store)
	if r.Ready || !r.Stale {
		t.Fatalf("ready/stale = %v/%v, want false/true for owner mismatch: %+v", r.Ready, r.Stale, r)
	}
	if !strings.Contains(r.Reason, "fingerprint") {
		t.Fatalf("reason = %q, want owner fingerprint explanation", r.Reason)
	}
}

func TestResolveSemanticIndexReadinessQdrantModelMismatch(t *testing.T) {
	store := configureSemanticStore(t, nil)
	p := &QdrantPointer{
		Backend:        models.SemanticVectorBackendQdrant,
		CollectionUUID: "8f2c6a7b-91d4-4f6a-b9f7-2ef84d72a9c1",
		ChunkVersion:   ChunkVersion,
		Embedding:      QdrantEmbeddingPointer{Model: "other-model", Dimensions: 384},
		Owner:          QdrantOwnerPointer{StoreRootFingerprint: StoreRootFingerprint(store.Root)},
		ChunkCount:     10,
	}
	if err := SaveQdrantPointer(store.Root, p); err != nil {
		t.Fatalf("save qdrant pointer: %v", err)
	}
	r := ResolveSemanticIndexReadiness(store)
	if r.Ready || !r.Stale {
		t.Fatalf("ready/stale = %v/%v, want false/true for model mismatch: %+v", r.Ready, r.Stale, r)
	}
}

func TestResolveSemanticIndexReadinessQdrantZeroChunks(t *testing.T) {
	store := configureSemanticStore(t, nil)
	p := &QdrantPointer{
		Backend:        models.SemanticVectorBackendQdrant,
		CollectionUUID: "8f2c6a7b-91d4-4f6a-b9f7-2ef84d72a9c1",
		ChunkVersion:   ChunkVersion,
		Embedding:      QdrantEmbeddingPointer{Model: "gte-small", Dimensions: 384},
		Owner:          QdrantOwnerPointer{StoreRootFingerprint: StoreRootFingerprint(store.Root)},
		ChunkCount:     0,
	}
	if err := SaveQdrantPointer(store.Root, p); err != nil {
		t.Fatalf("save qdrant pointer: %v", err)
	}
	r := ResolveSemanticIndexReadiness(store)
	if r.Ready {
		t.Fatalf("ready = true, want false for zero chunk pointer")
	}
	if !r.Degraded {
		t.Fatalf("degraded = false, want true for zero chunk pointer")
	}
}

func TestResolveSemanticIndexReadinessQdrantMalformedPointer(t *testing.T) {
	store := configureSemanticStore(t, nil)
	path := QdrantPointerPath(store.Root)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte("{not json"), 0644); err != nil {
		t.Fatalf("write malformed pointer: %v", err)
	}
	r := ResolveSemanticIndexReadiness(store)
	if r.Ready {
		t.Fatalf("ready = true, want false for malformed pointer")
	}
	if !r.Degraded {
		t.Fatalf("degraded = false, want true for malformed pointer")
	}
	if !strings.Contains(r.Reason, "read qdrant pointer") {
		t.Fatalf("reason = %q, want pointer read error", r.Reason)
	}
}

func TestSemanticIndexAvailableForRuntimeQdrantPointer(t *testing.T) {
	store := configureSemanticStore(t, nil)
	cfg, err := loadSemanticRuntimeConfig(store)
	if err != nil {
		t.Fatalf("load runtime config: %v", err)
	}

	// No pointer, no sqlite index -> unavailable.
	available, err := semanticIndexAvailableForType(store, cfg, nil)
	if err != nil || available {
		t.Fatalf("available = %v, err = %v; want false, nil with no index", available, err)
	}

	// Valid pointer -> available.
	writeReadyQdrantPointer(t, store)
	available, err = semanticIndexAvailableForType(store, cfg, nil)
	if err != nil {
		t.Fatalf("available with pointer: %v", err)
	}
	if !available {
		t.Fatal("available = false, want true with valid qdrant pointer")
	}

	// Pointer present but stale -> unavailable.
	if err := SaveQdrantPointer(store.Root, &QdrantPointer{
		Backend:        models.SemanticVectorBackendQdrant,
		CollectionUUID: "8f2c6a7b-91d4-4f6a-b9f7-2ef84d72a9c1",
		ChunkVersion:   ChunkVersion,
		Embedding:      QdrantEmbeddingPointer{Model: "other-model", Dimensions: 384},
		Owner:          QdrantOwnerPointer{StoreRootFingerprint: StoreRootFingerprint(store.Root)},
		ChunkCount:     10,
	}); err != nil {
		t.Fatalf("save stale pointer: %v", err)
	}
	available, err = semanticIndexAvailableForType(store, cfg, nil)
	if err != nil || available {
		t.Fatalf("available = %v, err = %v; want false, nil for stale pointer", available, err)
	}
}

func TestSemanticIndexAvailableForRuntimeSQLiteLegacyFallback(t *testing.T) {
	store := configureSemanticStore(t, nil) // qdrant default, no pointer
	seedRuntimeSearchIndex(t, store.Root, "gte-small", 384)
	cfg, err := loadSemanticRuntimeConfig(store)
	if err != nil {
		t.Fatalf("load runtime config: %v", err)
	}
	available, err := semanticIndexAvailableForType(store, cfg, chunkTypesForRuntimePreflight("doc"))
	if err != nil {
		t.Fatalf("sqlite legacy availability: %v", err)
	}
	if !available {
		t.Fatal("available = false, want true via legacy sqlite fallback")
	}
}

func TestSemanticIndexAvailableForRuntimeBackendNone(t *testing.T) {
	store := configureSemanticStore(t, &models.SemanticVectorStoreSettings{Backend: models.SemanticVectorBackendNone})
	seedRuntimeSearchIndex(t, store.Root, "gte-small", 384)
	cfg, err := loadSemanticRuntimeConfig(store)
	if err != nil {
		t.Fatalf("load runtime config: %v", err)
	}
	available, err := semanticIndexAvailableForType(store, cfg, nil)
	if err != nil {
		t.Fatalf("backend none availability: %v", err)
	}
	if available {
		t.Fatal("available = true, want false for backend none")
	}

	// The full runtime preflight treats opt-out as not-configured, never as a
	// hard failure.
	_, preflightErr := semanticIndexAvailableForRuntime(store, "")
	if !errors.Is(preflightErr, ErrSemanticNotConfigured) {
		t.Fatalf("preflight error = %v, want ErrSemanticNotConfigured", preflightErr)
	}
}

func TestSearchWithRuntimeHybridQdrantPointerReady(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	store := newRuntimeSearchStore(t)
	seedRuntimeSearchIndex(t, store.Root, "gte-small", 384)
	writeReadyQdrantPointer(t, store)
	openCount := 0
	rt := NewSemanticRuntime(SemanticRuntimeOptions{
		IdleTimeout: time.Hour,
		openEmbedder: func(cfg semanticRuntimeConfig) (EmbedderProvider, error) {
			openCount++
			return &countingEmbedder{dimensions: cfg.dimensions}, nil
		},
	})
	oldRuntime := defaultSemanticRuntime
	defaultSemanticRuntime = rt
	defer func() {
		defaultSemanticRuntime = oldRuntime
		rt.Close()
	}()

	response, err := SearchWithRuntime(store, SearchOptions{
		Query: "runtime",
		Mode:  string(ModeHybrid),
		Limit: 5,
	})
	if err != nil {
		t.Fatalf("SearchWithRuntime hybrid with qdrant pointer: %v", err)
	}
	if response.Runtime == nil || !response.Runtime.Degraded || !strings.Contains(response.Runtime.Message, "semantic vector query failed") {
		t.Fatalf("runtime metadata = %+v, want actionable degradation when pointed Qdrant is unreachable", response.Runtime)
	}
	if len(response.Results) == 0 {
		t.Fatal("expected search results with valid qdrant pointer")
	}
	if openCount == 0 {
		t.Fatal("openCount = 0, want provider opened for available semantic index")
	}
}

func TestRuntimeQdrantQueryFailureDegradesHybridAndRetrieveButFailsSemantic(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "qdrant unavailable", http.StatusServiceUnavailable)
	}))
	defer server.Close()
	store := newRuntimeSearchStore(t)
	project, _ := store.Config.Load()
	project.Settings.SemanticSearch.VectorStore = &models.SemanticVectorStoreSettings{Backend: models.SemanticVectorBackendQdrant, Mode: models.SemanticVectorStoreModeExternal, ExternalURL: server.URL}
	if err := store.Config.Save(project); err != nil {
		t.Fatal(err)
	}
	writeReadyQdrantPointer(t, store)
	rt := NewSemanticRuntime(SemanticRuntimeOptions{IdleTimeout: time.Hour, openEmbedder: func(cfg semanticRuntimeConfig) (EmbedderProvider, error) {
		return &countingEmbedder{dimensions: cfg.dimensions}, nil
	}})
	old := defaultSemanticRuntime
	defaultSemanticRuntime = rt
	defer func() { defaultSemanticRuntime = old; rt.Close() }()
	// Use the TLS test client's trust roots through a direct production store.
	client, _ := NewQdrantHTTPClient(QdrantClientConfig{URL: server.URL, HTTPClient: server.Client()})
	pointer, _ := LoadQdrantPointer(store.Root)
	oldOpen := openQdrantVectorStoreOverride
	openQdrantVectorStoreOverride = func(*storage.Store, string, int) (VectorStore, error) {
		return &QdrantVectorStore{store: store, client: client, pointer: pointer, model: "gte-small", dims: 384}, nil
	}
	defer func() { openQdrantVectorStoreOverride = oldOpen }()
	hybrid, err := SearchWithRuntime(store, SearchOptions{Query: "runtime", Mode: string(ModeHybrid), Limit: 5})
	if err != nil {
		t.Fatal(err)
	}
	if hybrid.Runtime == nil || !hybrid.Runtime.Degraded || !strings.Contains(hybrid.Runtime.Message, "503") {
		t.Fatalf("hybrid runtime=%#v", hybrid.Runtime)
	}
	if len(hybrid.Results) == 0 {
		t.Fatal("hybrid lost keyword fallback")
	}
	if _, err := SearchWithRuntime(store, SearchOptions{Query: "runtime", Mode: string(ModeSemantic), Limit: 5}); err == nil || !strings.Contains(err.Error(), "503") {
		t.Fatalf("semantic err=%v", err)
	}
	retrieved, meta, err := RetrieveWithRuntime(store, models.RetrievalOptions{Query: "runtime", Mode: string(ModeHybrid), Limit: 5})
	if err != nil {
		t.Fatal(err)
	}
	if meta == nil || !meta.Degraded || len(retrieved.Candidates) == 0 {
		t.Fatalf("retrieve meta=%#v candidates=%d", meta, len(retrieved.Candidates))
	}
}

func TestEntitiesOnlyStaleDistinguishesEntityLagFromPointerFailure(t *testing.T) {
	// A stale entity and a stale pointer are repaired differently: the first by
	// per-entity reconciliation, the second by rebuilding the collection.
	// Callers scoped to pointer metadata rely on this flag to tell them apart.
	stale := runtimequeue.QdrantIntent{EntityType: "task", EntityID: "lagging", Revision: 1, Operation: "update", CanonicalHash: "canonical-hash", Path: "tasks/lagging.md", BatchID: "public-hook"}

	t.Run("valid pointer with lagging entity", func(t *testing.T) {
		store := configureSemanticStore(t, nil)
		writeReadyQdrantPointer(t, store)
		if err := markQdrantIntentPending(store.Root, stale); err != nil {
			t.Fatal(err)
		}
		r := ResolveSemanticIndexReadiness(store)
		if !r.Stale || !r.EntitiesOnlyStale || r.EntityStaleCount == 0 {
			t.Fatalf("entity lag not attributed to entities: %+v", r)
		}
	})

	t.Run("pointer mismatch outranks entity lag", func(t *testing.T) {
		store := configureSemanticStore(t, nil)
		writeReadyQdrantPointer(t, store)
		pointer, err := LoadQdrantPointer(store.Root)
		if err != nil {
			t.Fatal(err)
		}
		pointer.Embedding.Model = "some-other-model"
		if err := SaveQdrantPointer(store.Root, pointer); err != nil {
			t.Fatal(err)
		}
		if err := markQdrantIntentPending(store.Root, stale); err != nil {
			t.Fatal(err)
		}
		r := ResolveSemanticIndexReadiness(store)
		if !r.Stale {
			t.Fatalf("stale = false for pointer model mismatch: %+v", r)
		}
		if r.EntitiesOnlyStale {
			t.Fatalf("pointer mismatch misreported as entities-only: %+v", r)
		}
	})
}
