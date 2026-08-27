package search

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

// ErrSemanticNotConfigured is returned when semantic search is not enabled in config.
var ErrSemanticNotConfigured = fmt.Errorf("semantic search not configured or disabled")

// InitSemantic attempts to initialize semantic search components.
// Returns a descriptive error if initialization fails at any step.
// If the index is outdated (model or chunk version changed), it auto-reindexes.
// On success, the caller is responsible for calling vecStore.Close() and
// embedder.Close() when done.
func InitCodeStore(store *storage.Store) (VectorStore, error) {
	cfg, err := store.Config.Load()
	if err != nil {
		return nil, fmt.Errorf("load config: %w", err)
	}
	model := "code-keyword"
	if cfg != nil {
		if ss := cfg.Settings.EffectiveSemanticSearch(); ss != nil && ss.Model != "" {
			model = ss.Model
		}
	}

	vecStore := NewSQLiteVectorStore(store.Root, model, 1)
	if err := vecStore.Load(); err != nil {
		return nil, err
	}
	return vecStore, nil
}

func InitSemantic(store *storage.Store) (EmbedderProvider, VectorStore, error) {
	cfg, err := store.Config.Load()
	if err != nil {
		return nil, nil, fmt.Errorf("load config: %w", err)
	}
	if cfg == nil {
		return nil, nil, ErrSemanticNotConfigured
	}

	// Resolved per spec ollama-only-embedding D1/FR-3: a project declaring
	// provider: local (or omitted) is treated as provider: ollama with the
	// D2 default model here, in memory, without rewriting config.json.
	ss := cfg.Settings.EffectiveSemanticSearch()
	if ss == nil || !ss.Enabled || ss.Model == "" {
		return nil, nil, ErrSemanticNotConfigured
	}

	// The deterministic embedder replaces the API provider entirely, so a CI
	// run can exercise the semantic and hybrid paths with no Ollama, no model
	// download and no network. It is opt-in through an environment variable and
	// never reached unless that variable is set.
	if MockEmbedderEnabled() {
		embedder := NewMockEmbedder()
		// A distinct model name keeps the mock's vectors in their own store, so
		// a CI run can never leave vectors behind that a real run would then
		// read back as if a real model had produced them.
		vecStore := NewSQLiteVectorStore(filepath.Join(store.Root, ".search"),
			embedder.ModelConfig().Name, embedder.Dimensions())
		if err := vecStore.Load(); err != nil {
			return nil, nil, fmt.Errorf("load mock vector store: %w", err)
		}
		return embedder, vecStore, nil
	}

	return initSemanticAPI(store, ss)
}

// initSemanticAPI initializes semantic search using an OpenAI-compatible API provider.
func initSemanticAPI(store *storage.Store, ss *models.SemanticSearchSettings) (EmbedderProvider, VectorStore, error) {
	settingsStore := storage.NewEmbeddingSettingsStore()
	settings, err := settingsStore.Load()
	if err != nil {
		return nil, nil, fmt.Errorf("load embedding settings: %w", err)
	}

	model, err := settings.GetModel(ss.Model)
	if err != nil {
		return nil, nil, fmt.Errorf("resolve embedding model: %w", err)
	}

	provider, err := settings.GetProvider(model.Provider)
	if err != nil {
		return nil, nil, fmt.Errorf("resolve embedding provider: %w", err)
	}
	provider = provider.WithDefaults()

	// Project settings win over the machine-wide registry (same precedence
	// semantic_runtime.go's semanticRuntimeAPIConfig uses), and only then the
	// embedder's own conservative default. Leaving MaxTokens unset here would
	// silently fall the embedder back to defaultAPIMaxTokens (512) regardless
	// of the model's real context limit — exactly the FR-12 failure mode.
	maxTokens := ss.MaxTokens
	if maxTokens <= 0 {
		maxTokens = model.MaxTokens
	}

	embedder, err := NewAPIEmbedder(APIEmbedderConfig{
		APIBase:     provider.APIBase,
		APIKey:      provider.APIKey,
		Model:       model.Model,
		Dimensions:  model.Dimensions,
		MaxTokens:   maxTokens,
		Timeout:     provider.Timeout,
		BatchSize:   provider.BatchSize,
		Retry:       provider.Retry,
		QueryPrefix: model.QueryPrefix,
		DocPrefix:   model.DocPrefix,
	})
	if err != nil {
		return nil, nil, fmt.Errorf("init API embedder: %w", err)
	}

	searchDir := filepath.Join(store.Root, ".search")
	vecStore := NewSQLiteVectorStore(searchDir, ss.Model, model.Dimensions)
	if err := vecStore.Load(); err != nil {
		return nil, nil, fmt.Errorf("load vector store: %w", err)
	}

	// Auto-reindex if model changed.
	if vecStore.NeedsRebuild(ss.Model) && vecStore.Count() > 0 {
		svc := NewIndexService(store, embedder, vecStore)
		if err := svc.Reindex(nil); err != nil {
			fmt.Fprintf(os.Stderr, "warning: auto-reindex failed: %v\n", err)
		}
	}

	return embedder, vecStore, nil
}
