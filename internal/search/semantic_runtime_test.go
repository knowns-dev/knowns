package search

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/runtimequeue"
	"github.com/howznguyen/knowns/internal/storage"
)

type countingEmbedder struct {
	dimensions int
	closed     *int
}

func (e *countingEmbedder) Embed(text string) ([]float32, error) {
	return e.EmbedDocument(text)
}

func (e *countingEmbedder) EmbedDocument(string) ([]float32, error) {
	return make([]float32, e.dimensions), nil
}

func (e *countingEmbedder) EmbedQuery(string) ([]float32, error) {
	return make([]float32, e.dimensions), nil
}

func (e *countingEmbedder) EmbedBatch(texts []string) ([][]float32, error) {
	return e.EmbedDocumentBatch(texts)
}

func (e *countingEmbedder) EmbedDocumentBatch(texts []string) ([][]float32, error) {
	vecs := make([][]float32, len(texts))
	for i := range texts {
		vecs[i] = make([]float32, e.dimensions)
	}
	return vecs, nil
}

func (e *countingEmbedder) EmbedQueryBatch(texts []string) ([][]float32, error) {
	return e.EmbedDocumentBatch(texts)
}

func (e *countingEmbedder) Dimensions() int {
	return e.dimensions
}

func (e *countingEmbedder) ModelConfig() EmbeddingModelConfig {
	return EmbeddingModelConfig{Name: "test", Dimensions: e.dimensions, MaxTokens: 512}
}

func (e *countingEmbedder) GetTokenizer() Tokenizer {
	return nil
}

func (e *countingEmbedder) Close() {
	if e.closed != nil {
		*e.closed = *e.closed + 1
	}
}

func TestSemanticRuntimeReusesEmbedderForSameProviderModel(t *testing.T) {
	store := newSemanticRuntimeTestStore(t, "gte-small", 384)
	now := time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)
	openCount := 0
	closeCount := 0
	rt := NewSemanticRuntime(SemanticRuntimeOptions{
		IdleTimeout: time.Hour,
		Now: func() time.Time {
			return now
		},
		openEmbedder: func(cfg semanticRuntimeConfig) (EmbedderProvider, error) {
			openCount++
			return &countingEmbedder{dimensions: cfg.dimensions, closed: &closeCount}, nil
		},
	})
	defer rt.Close()

	first, err := rt.OpenSession(store)
	if err != nil {
		t.Fatalf("open first session: %v", err)
	}
	defer first.Close()
	second, err := rt.OpenSession(store)
	if err != nil {
		t.Fatalf("open second session: %v", err)
	}
	defer second.Close()

	if openCount != 1 {
		t.Fatalf("openCount = %d, want 1", openCount)
	}
	first.Embedder.Close()
	second.Embedder.Close()
	if closeCount != 0 {
		t.Fatalf("session embedder Close closed cached provider: closeCount=%d", closeCount)
	}
	status := rt.Status()
	if len(status.Entries) != 1 {
		t.Fatalf("status entries = %d, want 1", len(status.Entries))
	}
	if !status.Entries[0].Loaded {
		t.Fatalf("runtime entry should be loaded")
	}
}

func TestSemanticRuntimeConcurrentSessionsOpenSingleProvider(t *testing.T) {
	store := newSemanticRuntimeTestStore(t, "gte-small", 384)
	openCount := 0
	var mu sync.Mutex
	rt := NewSemanticRuntime(SemanticRuntimeOptions{
		IdleTimeout: time.Hour,
		openEmbedder: func(cfg semanticRuntimeConfig) (EmbedderProvider, error) {
			mu.Lock()
			openCount++
			mu.Unlock()
			time.Sleep(10 * time.Millisecond)
			return &countingEmbedder{dimensions: cfg.dimensions}, nil
		},
	})
	defer rt.Close()

	const workers = 4
	start := make(chan struct{})
	errs := make(chan error, workers)
	var wg sync.WaitGroup
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			session, err := rt.OpenSession(store)
			if err != nil {
				errs <- err
				return
			}
			errs <- session.Close()
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("open concurrent session: %v", err)
		}
	}
	mu.Lock()
	gotOpenCount := openCount
	mu.Unlock()
	if gotOpenCount != 1 {
		t.Fatalf("openCount = %d, want 1 shared provider for concurrent sessions", gotOpenCount)
	}
	status := rt.Status()
	if len(status.Entries) != 1 || !status.Entries[0].Loaded {
		t.Fatalf("runtime status entries = %+v, want one loaded entry", status.Entries)
	}
}

func TestSemanticRuntimeCacheKeySeparatesDimensions(t *testing.T) {
	firstStore := newSemanticRuntimeTestStore(t, "gte-small", 384)
	secondStore := newSemanticRuntimeTestStore(t, "gte-small", 768)
	openCount := 0
	rt := NewSemanticRuntime(SemanticRuntimeOptions{
		IdleTimeout: time.Hour,
		openEmbedder: func(cfg semanticRuntimeConfig) (EmbedderProvider, error) {
			openCount++
			return &countingEmbedder{dimensions: cfg.dimensions}, nil
		},
	})
	defer rt.Close()

	first, err := rt.OpenSession(firstStore)
	if err != nil {
		t.Fatalf("open first session: %v", err)
	}
	defer first.Close()
	second, err := rt.OpenSession(secondStore)
	if err != nil {
		t.Fatalf("open second session: %v", err)
	}
	defer second.Close()

	if openCount != 2 {
		t.Fatalf("openCount = %d, want 2 for distinct dimensions", openCount)
	}
}

func TestSemanticRuntimeCacheKeySeparatesAPIProviderSettings(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	store := newSemanticRuntimeTestStoreWithProvider(t, "api-model", 384, "api")
	saveEmbeddingSettings(t, "first-key")
	openCount := 0
	rt := NewSemanticRuntime(SemanticRuntimeOptions{
		IdleTimeout: time.Hour,
		openEmbedder: func(cfg semanticRuntimeConfig) (EmbedderProvider, error) {
			openCount++
			return &countingEmbedder{dimensions: cfg.dimensions}, nil
		},
	})
	defer rt.Close()

	first, err := rt.OpenSession(store)
	if err != nil {
		t.Fatalf("open first session: %v", err)
	}
	defer first.Close()
	saveEmbeddingSettings(t, "second-key")
	second, err := rt.OpenSession(store)
	if err != nil {
		t.Fatalf("open second session: %v", err)
	}
	defer second.Close()

	if openCount != 2 {
		t.Fatalf("openCount = %d, want 2 after API key change", openCount)
	}
	if strings.Contains(first.CacheKey, "first-key") || strings.Contains(second.CacheKey, "second-key") {
		t.Fatalf("cache key leaked raw API key")
	}
}

func TestSemanticRuntimeOllamaProviderUsesRuntimeConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	store := newSemanticRuntimeTestStoreWithProvider(t, "api-model", 384, "ollama")
	saveEmbeddingSettings(t, "ollama-key")
	openCount := 0
	rt := NewSemanticRuntime(SemanticRuntimeOptions{
		IdleTimeout: time.Hour,
		openEmbedder: func(cfg semanticRuntimeConfig) (EmbedderProvider, error) {
			openCount++
			if cfg.provider != "ollama" {
				t.Fatalf("provider = %q, want ollama", cfg.provider)
			}
			if !strings.Contains(cfg.cacheKey, "provider=ollama") {
				t.Fatalf("cache key = %q, want ollama provider identity", cfg.cacheKey)
			}
			return &countingEmbedder{dimensions: cfg.dimensions}, nil
		},
	})
	defer rt.Close()

	session, err := rt.OpenSession(store)
	if err != nil {
		t.Fatalf("open ollama session: %v", err)
	}
	defer session.Close()

	if openCount != 1 {
		t.Fatalf("openCount = %d, want 1", openCount)
	}
	status := rt.Status()
	if len(status.Entries) != 1 {
		t.Fatalf("status entries = %d, want 1", len(status.Entries))
	}
	if status.Entries[0].Provider != "ollama" {
		t.Fatalf("status provider = %q, want ollama", status.Entries[0].Provider)
	}
}

func TestSemanticRuntimeDisabledByEnv(t *testing.T) {
	t.Setenv("KNOWNS_SEMANTIC_RUNTIME_DISABLED", "1")
	store := newSemanticRuntimeTestStore(t, "gte-small", 384)
	rt := NewSemanticRuntime(SemanticRuntimeOptions{})
	defer rt.Close()

	_, err := rt.OpenSession(store)
	if !errors.Is(err, ErrSemanticRuntimeDisabled) {
		t.Fatalf("err = %v, want ErrSemanticRuntimeDisabled", err)
	}
	status := rt.Status()
	if status.Enabled {
		t.Fatalf("status enabled = true, want false")
	}
	if status.DisabledBy == "" {
		t.Fatalf("status disabled reason is empty")
	}
}

func TestObservedSemanticRuntimeStatusUsesPersistedSnapshot(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	writeCurrentRuntimePIDForTest(t)
	store := newSemanticRuntimeTestStore(t, "gte-small", 384)
	rt := NewSemanticRuntime(SemanticRuntimeOptions{
		IdleTimeout: time.Hour,
		openEmbedder: func(cfg semanticRuntimeConfig) (EmbedderProvider, error) {
			return &countingEmbedder{dimensions: cfg.dimensions}, nil
		},
	})
	oldRuntime := defaultSemanticRuntime
	defaultSemanticRuntime = rt
	session, err := InitSemanticRuntimeSession(store)
	if err != nil {
		t.Fatalf("open runtime session: %v", err)
	}
	if err := session.Close(); err != nil {
		t.Fatalf("close runtime session: %v", err)
	}
	if err := PersistDefaultSemanticRuntimeStatus(); err != nil {
		t.Fatalf("persist runtime status: %v", err)
	}
	rt.Close()
	defaultSemanticRuntime = NewSemanticRuntime(SemanticRuntimeOptions{})
	defer func() {
		defaultSemanticRuntime.Close()
		defaultSemanticRuntime = oldRuntime
	}()

	status := ObservedSemanticRuntimeStatus()
	if len(status.Entries) != 1 {
		t.Fatalf("observed status entries = %d, want persisted daemon entry", len(status.Entries))
	}
	if !status.Entries[0].Loaded {
		t.Fatalf("observed status entry should be loaded from persisted daemon snapshot")
	}
	if status.Entries[0].Model != "gte-small" {
		t.Fatalf("observed status model = %q, want gte-small", status.Entries[0].Model)
	}
}

func TestObservedSemanticRuntimeStatusIgnoresSnapshotWhenDaemonStopped(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	store := newSemanticRuntimeTestStore(t, "gte-small", 384)
	rt := NewSemanticRuntime(SemanticRuntimeOptions{
		IdleTimeout: time.Hour,
		openEmbedder: func(cfg semanticRuntimeConfig) (EmbedderProvider, error) {
			return &countingEmbedder{dimensions: cfg.dimensions}, nil
		},
	})
	oldRuntime := defaultSemanticRuntime
	defaultSemanticRuntime = rt
	session, err := InitSemanticRuntimeSession(store)
	if err != nil {
		t.Fatalf("open runtime session: %v", err)
	}
	if err := session.Close(); err != nil {
		t.Fatalf("close runtime session: %v", err)
	}
	if err := PersistDefaultSemanticRuntimeStatus(); err != nil {
		t.Fatalf("persist runtime status: %v", err)
	}
	rt.Close()
	defaultSemanticRuntime = NewSemanticRuntime(SemanticRuntimeOptions{})
	defer func() {
		defaultSemanticRuntime.Close()
		defaultSemanticRuntime = oldRuntime
	}()

	status := ObservedSemanticRuntimeStatus()
	if len(status.Entries) != 0 {
		t.Fatalf("observed status entries = %d, want no stale daemon entries", len(status.Entries))
	}
}

func TestSemanticRuntimeUnloadIdleClosesProvider(t *testing.T) {
	store := newSemanticRuntimeTestStore(t, "gte-small", 384)
	now := time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)
	closeCount := 0
	rt := NewSemanticRuntime(SemanticRuntimeOptions{
		IdleTimeout: time.Second,
		Now: func() time.Time {
			return now
		},
		openEmbedder: func(cfg semanticRuntimeConfig) (EmbedderProvider, error) {
			return &countingEmbedder{dimensions: cfg.dimensions, closed: &closeCount}, nil
		},
	})
	defer rt.Close()

	session, err := rt.OpenSession(store)
	if err != nil {
		t.Fatalf("open session: %v", err)
	}
	if err := session.Close(); err != nil {
		t.Fatalf("close session: %v", err)
	}
	now = now.Add(2 * time.Second)
	if err := rt.UnloadIdle(); err != nil {
		t.Fatalf("unload idle: %v", err)
	}
	if closeCount != 1 {
		t.Fatalf("closeCount = %d, want 1", closeCount)
	}
	if entries := rt.Status().Entries; len(entries) != 0 {
		t.Fatalf("status entries after unload = %d, want 0", len(entries))
	}
}

func TestSemanticRuntimeDoesNotUnloadActiveSession(t *testing.T) {
	store := newSemanticRuntimeTestStore(t, "gte-small", 384)
	now := time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)
	closeCount := 0
	rt := NewSemanticRuntime(SemanticRuntimeOptions{
		IdleTimeout: time.Second,
		Now: func() time.Time {
			return now
		},
		openEmbedder: func(cfg semanticRuntimeConfig) (EmbedderProvider, error) {
			return &countingEmbedder{dimensions: cfg.dimensions, closed: &closeCount}, nil
		},
	})
	defer rt.Close()

	session, err := rt.OpenSession(store)
	if err != nil {
		t.Fatalf("open session: %v", err)
	}
	defer session.Close()
	now = now.Add(2 * time.Second)
	if err := rt.UnloadIdle(); err != nil {
		t.Fatalf("unload idle: %v", err)
	}
	if closeCount != 0 {
		t.Fatalf("closeCount = %d, want 0 while session is active", closeCount)
	}
	status := rt.Status()
	if len(status.Entries) != 1 {
		t.Fatalf("status entries = %d, want 1", len(status.Entries))
	}
	if got := status.Entries[0].ActiveSessions; got != 1 {
		t.Fatalf("active sessions = %d, want 1", got)
	}
}

func newSemanticRuntimeTestStore(t *testing.T, model string, dimensions int) *storage.Store {
	return newSemanticRuntimeTestStoreWithProvider(t, model, dimensions, "local")
}

func newSemanticRuntimeTestStoreWithProvider(t *testing.T, model string, dimensions int, provider string) *storage.Store {
	t.Helper()
	root := filepath.Join(t.TempDir(), ".knowns")
	if err := os.MkdirAll(root, 0755); err != nil {
		t.Fatalf("mkdir store: %v", err)
	}
	store := storage.NewStore(root)
	project := &models.Project{
		Name: "semantic-runtime-test",
		ID:   "semantic-runtime-test",
		Settings: models.ProjectSettings{
			SemanticSearch: &models.SemanticSearchSettings{
				Enabled:    true,
				Provider:   provider,
				Model:      model,
				Dimensions: dimensions,
			},
		},
	}
	if err := store.Config.Save(project); err != nil {
		t.Fatalf("save config: %v", err)
	}
	return store
}

func saveEmbeddingSettings(t *testing.T, apiKey string) {
	t.Helper()
	settings := &storage.EmbeddingSettings{
		Providers: map[string]storage.EmbeddingProvider{
			"test-provider": {
				Name:      "test-provider",
				APIBase:   "https://embeddings.example.test/v1",
				APIKey:    apiKey,
				Timeout:   11,
				BatchSize: 7,
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

func writeCurrentRuntimePIDForTest(t *testing.T) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(runtimequeue.PIDFile()), 0755); err != nil {
		t.Fatalf("mkdir runtime pid dir: %v", err)
	}
	if err := os.WriteFile(runtimequeue.PIDFile(), []byte(strconv.Itoa(os.Getpid())), 0644); err != nil {
		t.Fatalf("write runtime pid: %v", err)
	}
	t.Cleanup(func() {
		_ = os.Remove(runtimequeue.PIDFile())
	})
}
