package search

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/runtimequeue"
	"github.com/howznguyen/knowns/internal/storage"
)

func TestSearchWithRuntimeKeywordBypassesSemanticRuntime(t *testing.T) {
	store := newRuntimeSearchStore(t)
	openCount := 0
	rt := NewSemanticRuntime(SemanticRuntimeOptions{
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
		Mode:  string(ModeKeyword),
		Limit: 5,
	})
	if err != nil {
		t.Fatalf("SearchWithRuntime keyword: %v", err)
	}
	if len(response.Results) == 0 {
		t.Fatalf("expected keyword results")
	}
	if response.Runtime != nil {
		t.Fatalf("runtime metadata = %+v, want nil", response.Runtime)
	}
	if openCount != 0 {
		t.Fatalf("openCount = %d, want 0 for keyword mode", openCount)
	}
}

func TestSearchWithRuntimeSemanticUnavailableFails(t *testing.T) {
	store := newRuntimeSearchStore(t)
	t.Setenv("KNOWNS_SEMANTIC_RUNTIME_DISABLED", "1")

	_, err := SearchWithRuntime(store, SearchOptions{
		Query: "runtime",
		Mode:  string(ModeSemantic),
		Limit: 5,
	})
	if err == nil {
		t.Fatal("expected semantic runtime error")
	}
	if !errors.Is(err, ErrSemanticRuntimeDisabled) {
		t.Fatalf("err = %v, want ErrSemanticRuntimeDisabled", err)
	}
}

func TestSearchWithRuntimeHybridUnavailableFallsBackWithMetadata(t *testing.T) {
	store := newRuntimeSearchStore(t)
	t.Setenv("KNOWNS_SEMANTIC_RUNTIME_DISABLED", "1")

	response, err := SearchWithRuntime(store, SearchOptions{
		Query: "runtime",
		Mode:  string(ModeHybrid),
		Limit: 5,
	})
	if err != nil {
		t.Fatalf("SearchWithRuntime hybrid: %v", err)
	}
	if len(response.Results) == 0 {
		t.Fatalf("expected keyword fallback results")
	}
	if response.Runtime == nil || !response.Runtime.Degraded {
		t.Fatalf("runtime metadata = %+v, want degraded", response.Runtime)
	}
	if response.Runtime.Reason != "disabled" {
		t.Fatalf("runtime reason = %q, want disabled", response.Runtime.Reason)
	}
	for _, result := range response.Results {
		if len(result.MatchedBy) != 1 || result.MatchedBy[0] != string(MatchKeyword) {
			t.Fatalf("fallback result matchedBy = %#v, want keyword only", result.MatchedBy)
		}
		if result.Runtime == nil || !result.Runtime.Degraded {
			t.Fatalf("fallback result runtime metadata = %+v, want degraded", result.Runtime)
		}
	}
}

func TestSearchWithRuntimeHybridEmptyIndexDoesNotOpenProvider(t *testing.T) {
	store := newRuntimeSearchStore(t)
	openCount := 0
	rt := NewSemanticRuntime(SemanticRuntimeOptions{
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
		t.Fatalf("SearchWithRuntime hybrid: %v", err)
	}
	if len(response.Results) == 0 {
		t.Fatalf("expected keyword fallback results")
	}
	if response.Runtime == nil || !response.Runtime.Degraded {
		t.Fatalf("runtime metadata = %+v, want degraded", response.Runtime)
	}
	for _, result := range response.Results {
		if result.Runtime == nil || !result.Runtime.Degraded {
			t.Fatalf("fallback result runtime metadata = %+v, want degraded", result.Runtime)
		}
	}
	if openCount != 0 {
		t.Fatalf("openCount = %d, want 0 when semantic index is empty", openCount)
	}
}

func TestSearchWithRuntimeHybridStaleIndexDoesNotOpenProvider(t *testing.T) {
	store := newRuntimeSearchStore(t)
	seedRuntimeSearchIndex(t, store.Root, "old-model", 384)
	openCount := 0
	rt := NewSemanticRuntime(SemanticRuntimeOptions{
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
		t.Fatalf("SearchWithRuntime hybrid: %v", err)
	}
	if len(response.Results) == 0 {
		t.Fatalf("expected keyword fallback results")
	}
	if response.Runtime == nil || !response.Runtime.Degraded {
		t.Fatalf("runtime metadata = %+v, want degraded", response.Runtime)
	}
	for _, result := range response.Results {
		if result.Runtime == nil || !result.Runtime.Degraded {
			t.Fatalf("fallback result runtime metadata = %+v, want degraded", result.Runtime)
		}
	}
	if openCount != 0 {
		t.Fatalf("openCount = %d, want 0 when semantic index needs rebuild", openCount)
	}
}

func TestSearchWithRuntimeDaemonRoutingSharesProviderAcrossConcurrentCalls(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	store := newRuntimeSearchStore(t)
	seedRuntimeSearchIndex(t, store.Root, "gte-small", 384)
	openCount := 0
	var openMu sync.Mutex
	rt := NewSemanticRuntime(SemanticRuntimeOptions{
		IdleTimeout: time.Hour,
		openEmbedder: func(cfg semanticRuntimeConfig) (EmbedderProvider, error) {
			openMu.Lock()
			openCount++
			openMu.Unlock()
			return &countingEmbedder{dimensions: cfg.dimensions}, nil
		},
	})
	oldRuntime := defaultSemanticRuntime
	defaultSemanticRuntime = rt
	defer func() {
		defaultSemanticRuntime = oldRuntime
		rt.Close()
	}()

	ctx, cancel := context.WithCancel(context.Background())
	daemonErr := make(chan error, 1)
	go func() {
		daemonErr <- runtimequeue.RunDaemon(ctx, ExecuteRuntimeJob, nil)
	}()
	waitForRuntimeDaemon(t)
	defer func() {
		cancel()
		select {
		case err := <-daemonErr:
			if err != nil {
				t.Fatalf("runtime daemon: %v", err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("runtime daemon did not stop")
		}
	}()

	oldArg0 := os.Args[0]
	os.Args[0] = filepath.Join(t.TempDir(), "knowns")
	defer func() {
		os.Args[0] = oldArg0
	}()

	const calls = 2
	errs := make(chan error, calls)
	var wg sync.WaitGroup
	for range calls {
		wg.Add(1)
		go func() {
			defer wg.Done()
			response, err := SearchWithRuntime(store, SearchOptions{
				Query: "runtime semantic",
				Mode:  string(ModeHybrid),
				Limit: 5,
			})
			if err != nil {
				errs <- err
				return
			}
			if response.Runtime != nil && response.Runtime.Degraded {
				errs <- fmt.Errorf("daemon-routed search unexpectedly degraded: %+v", response.Runtime)
				return
			}
			if len(response.Results) == 0 {
				errs <- errors.New("daemon-routed search returned no results")
				return
			}
			errs <- nil
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	openMu.Lock()
	gotOpenCount := openCount
	openMu.Unlock()
	if gotOpenCount != 1 {
		t.Fatalf("openCount = %d, want 1 shared runtime-owned provider", gotOpenCount)
	}
}

func newRuntimeSearchStore(t *testing.T) *storage.Store {
	t.Helper()
	store := newSearchTestStore(t)
	project, err := store.Config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	project.Settings.SemanticSearch = &models.SemanticSearchSettings{
		Enabled:    true,
		Provider:   "local",
		Model:      "gte-small",
		Dimensions: 384,
	}
	if err := store.Config.Save(project); err != nil {
		t.Fatalf("save config: %v", err)
	}
	now := time.Now().UTC()
	if err := store.Docs.Create(&models.Doc{
		Path:      "runtime/semantic",
		Title:     "Semantic Runtime",
		Content:   "runtime semantic keyword fallback",
		CreatedAt: now,
		UpdatedAt: now,
	}); err != nil {
		t.Fatalf("create doc: %v", err)
	}
	return store
}

func seedRuntimeSearchIndex(t *testing.T, storeRoot, model string, dimensions int) {
	t.Helper()
	vecStore := NewSQLiteVectorStore(filepath.Join(storeRoot, ".search"), model, dimensions)
	if err := vecStore.Load(); err != nil {
		t.Fatalf("load vector store: %v", err)
	}
	defer vecStore.Close()
	embedding := make([]float32, dimensions)
	embedding[0] = 1
	vecStore.AddChunks([]Chunk{{
		ID:         "doc:runtime/semantic:chunk:1",
		Type:       ChunkTypeDoc,
		Content:    "runtime semantic keyword fallback",
		TokenCount: 4,
		Embedding:  embedding,
		DocPath:    "runtime/semantic",
		Position:   1,
	}})
	if err := vecStore.Save(); err != nil {
		t.Fatalf("save vector store: %v", err)
	}
}

func waitForRuntimeDaemon(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if runtimequeue.IsRunning() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("runtime daemon did not start")
}
