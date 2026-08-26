package search

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

var ErrSemanticRuntimeDisabled = errors.New("semantic runtime disabled")

const defaultSemanticRuntimeIdleTimeout = 2 * time.Minute

type SemanticRuntimeOptions struct {
	IdleTimeout time.Duration
	Now         func() time.Time

	openEmbedder func(semanticRuntimeConfig) (EmbedderProvider, error)
}

type SemanticRuntime struct {
	mu           sync.Mutex
	entries      map[string]*semanticRuntimeEntry
	idleTimeout  time.Duration
	now          func() time.Time
	openEmbedder func(semanticRuntimeConfig) (EmbedderProvider, error)
}

type SemanticSession struct {
	Embedder EmbedderProvider
	VecStore VectorStore
	CacheKey string

	runtime *SemanticRuntime
	entry   *semanticRuntimeEntry
	mu      sync.Mutex
	closed  bool
}

type SemanticRuntimeStatus struct {
	Enabled          bool                       `json:"enabled"`
	DisabledBy       string                     `json:"disabledBy,omitempty"`
	IdleTimeout      time.Duration              `json:"idleTimeout"`
	LastReloadAt     time.Time                  `json:"lastReloadAt,omitempty"`
	ReloadGeneration int64                      `json:"reloadGeneration,omitempty"`
	ReloadRequestID  string                     `json:"reloadRequestId,omitempty"`
	Entries          []SemanticRuntimeEntryInfo `json:"entries,omitempty"`
}

type SemanticRuntimeEntryInfo struct {
	Key              string        `json:"key"`
	Provider         string        `json:"provider"`
	Model            string        `json:"model"`
	Dimensions       int           `json:"dimensions"`
	Loaded           bool          `json:"loaded"`
	ActiveSessions   int           `json:"activeSessions,omitempty"`
	LastUsed         time.Time     `json:"lastUsed,omitempty"`
	IdleFor          time.Duration `json:"idleFor,omitempty"`
	IdleUnloadAfter  time.Time     `json:"idleUnloadAfter,omitempty"`
	StoreConsumers   []string      `json:"storeConsumers,omitempty"`
	ProviderIdentity string        `json:"providerIdentity,omitempty"`
}

type semanticRuntimeConfig struct {
	cacheKey         string
	provider         string
	providerIdentity string
	modelID          string
	modelName        string
	dimensions       int
	apiConfig        APIEmbedderConfig
}

type semanticRuntimeEntry struct {
	mu        sync.Mutex
	key       string
	cfg       semanticRuntimeConfig
	embedder  EmbedderProvider
	lastUsed  time.Time
	active    int
	consumers map[string]bool
}

var defaultSemanticRuntime = NewSemanticRuntime(SemanticRuntimeOptions{})

var semanticRuntimeReloadMu sync.RWMutex

var semanticRuntimeReload semanticRuntimeReloadMetadata

type semanticRuntimeReloadMetadata struct {
	LastReloadAt     time.Time
	ReloadGeneration int64
	ReloadRequestID  string
}

func setSemanticRuntimeReloadMetadata(status SemanticRuntimeStatus) {
	semanticRuntimeReloadMu.Lock()
	defer semanticRuntimeReloadMu.Unlock()
	semanticRuntimeReload = semanticRuntimeReloadMetadata{
		LastReloadAt:     status.LastReloadAt,
		ReloadGeneration: status.ReloadGeneration,
		ReloadRequestID:  status.ReloadRequestID,
	}
}

func currentSemanticRuntimeReloadMetadata() semanticRuntimeReloadMetadata {
	semanticRuntimeReloadMu.RLock()
	defer semanticRuntimeReloadMu.RUnlock()
	return semanticRuntimeReload
}

func NewSemanticRuntime(opts SemanticRuntimeOptions) *SemanticRuntime {
	idle := opts.IdleTimeout
	if idle <= 0 {
		idle = semanticRuntimeIdleTimeout()
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	openEmbedder := opts.openEmbedder
	if openEmbedder == nil {
		openEmbedder = openSemanticRuntimeEmbedder
	}
	return &SemanticRuntime{
		entries:      make(map[string]*semanticRuntimeEntry),
		idleTimeout:  idle,
		now:          now,
		openEmbedder: openEmbedder,
	}
}

func DefaultSemanticRuntime() *SemanticRuntime {
	return defaultSemanticRuntime
}

func InitSemanticRuntimeSession(store *storage.Store) (*SemanticSession, error) {
	return defaultSemanticRuntime.OpenSession(store)
}

func SemanticRuntimeEnabled() bool {
	disabled, _ := semanticRuntimeDisabledReason()
	return !disabled
}

func (r *SemanticRuntime) OpenSession(store *storage.Store) (*SemanticSession, error) {
	if store == nil {
		return nil, ErrSemanticNotConfigured
	}
	if disabled, reason := semanticRuntimeDisabledReason(); disabled {
		return nil, fmt.Errorf("%w: %s", ErrSemanticRuntimeDisabled, reason)
	}
	cfg, err := loadSemanticRuntimeConfig(store)
	if err != nil {
		return nil, err
	}
	if err := r.UnloadIdle(); err != nil {
		return nil, err
	}
	entry, err := r.entryForConfig(cfg)
	if err != nil {
		return nil, err
	}
	vecStore, err := openRuntimeVectorStore(store, cfg)
	if err != nil {
		// A first Qdrant generation has no pointer yet. Keep the cached embedder
		// usable for the explicit/background generation builder; normal search
		// preflight still degrades until activation creates the pointer.
		if resolveEffectiveVectorStore(store).Backend == models.SemanticVectorBackendQdrant {
			vecStore = newQdrantStageStore(cfg.modelID)
		} else {
			return nil, err
		}
	}
	now := r.now().UTC()
	entry.mu.Lock()
	entry.lastUsed = now
	entry.active++
	if entry.consumers == nil {
		entry.consumers = map[string]bool{}
	}
	entry.consumers[store.Root] = true
	entry.mu.Unlock()
	return &SemanticSession{
		Embedder: &runtimeEmbedder{entry: entry, runtime: r},
		VecStore: vecStore,
		CacheKey: cfg.cacheKey,
		runtime:  r,
		entry:    entry,
	}, nil
}

func (r *SemanticRuntime) Status() SemanticRuntimeStatus {
	disabled, reason := semanticRuntimeDisabledReason()
	reload := currentSemanticRuntimeReloadMetadata()
	status := SemanticRuntimeStatus{
		Enabled:          !disabled,
		DisabledBy:       reason,
		IdleTimeout:      r.idleTimeout,
		LastReloadAt:     reload.LastReloadAt,
		ReloadGeneration: reload.ReloadGeneration,
		ReloadRequestID:  reload.ReloadRequestID,
	}
	if disabled {
		return status
	}
	now := r.now().UTC()
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, entry := range r.entries {
		entry.mu.Lock()
		consumers := make([]string, 0, len(entry.consumers))
		for consumer := range entry.consumers {
			consumers = append(consumers, consumer)
		}
		info := SemanticRuntimeEntryInfo{
			Key:              entry.key,
			Provider:         entry.cfg.provider,
			Model:            entry.cfg.modelID,
			Dimensions:       entry.cfg.dimensions,
			Loaded:           entry.embedder != nil,
			ActiveSessions:   entry.active,
			LastUsed:         entry.lastUsed,
			IdleFor:          now.Sub(entry.lastUsed),
			IdleUnloadAfter:  entry.lastUsed.Add(r.idleTimeout),
			StoreConsumers:   consumers,
			ProviderIdentity: entry.cfg.providerIdentity,
		}
		entry.mu.Unlock()
		status.Entries = append(status.Entries, info)
	}
	return status
}

func (r *SemanticRuntime) UnloadIdle() error {
	now := r.now().UTC()
	r.mu.Lock()
	defer r.mu.Unlock()
	for key, entry := range r.entries {
		entry.mu.Lock()
		idle := entry.active == 0 && !entry.lastUsed.IsZero() && now.Sub(entry.lastUsed) >= r.idleTimeout
		if idle && entry.embedder != nil {
			entry.embedder.Close()
			entry.embedder = nil
			delete(r.entries, key)
		}
		entry.mu.Unlock()
	}
	return nil
}

func (r *SemanticRuntime) Close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for key, entry := range r.entries {
		entry.mu.Lock()
		if entry.embedder != nil {
			entry.embedder.Close()
			entry.embedder = nil
		}
		entry.mu.Unlock()
		delete(r.entries, key)
	}
}

func (r *SemanticRuntime) entryForConfig(cfg semanticRuntimeConfig) (*semanticRuntimeEntry, error) {
	r.mu.Lock()
	entry := r.entries[cfg.cacheKey]
	if entry == nil {
		entry = &semanticRuntimeEntry{
			key:       cfg.cacheKey,
			cfg:       cfg,
			consumers: map[string]bool{},
		}
		r.entries[cfg.cacheKey] = entry
	}
	r.mu.Unlock()

	entry.mu.Lock()
	defer entry.mu.Unlock()
	if entry.embedder == nil {
		embedder, err := r.openEmbedder(cfg)
		if err != nil {
			return nil, err
		}
		entry.embedder = embedder
	}
	entry.lastUsed = r.now().UTC()
	return entry, nil
}

func (s *SemanticSession) Close() error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	s.mu.Unlock()
	if s.entry != nil && s.runtime != nil {
		s.entry.mu.Lock()
		s.entry.lastUsed = s.runtime.now().UTC()
		if s.entry.active > 0 {
			s.entry.active--
		}
		s.entry.mu.Unlock()
	}
	if s.VecStore != nil {
		return s.VecStore.Close()
	}
	return nil
}

func (s *SemanticSession) Engine(store *storage.Store) *Engine {
	if s == nil {
		return NewEngine(store, nil, nil)
	}
	return NewEngine(store, s.Embedder, s.VecStore)
}

func (s *SemanticSession) IndexService(store *storage.Store) *IndexService {
	if s == nil {
		return NewIndexService(store, nil, nil)
	}
	return NewIndexService(store, s.Embedder, s.VecStore)
}

type runtimeEmbedder struct {
	entry   *semanticRuntimeEntry
	runtime *SemanticRuntime
}

func (e *runtimeEmbedder) Embed(text string) ([]float32, error) {
	return e.EmbedDocument(text)
}

func (e *runtimeEmbedder) EmbedDocument(text string) ([]float32, error) {
	e.entry.mu.Lock()
	defer e.entry.mu.Unlock()
	e.touchLocked()
	return e.entry.embedder.EmbedDocument(text)
}

func (e *runtimeEmbedder) EmbedQuery(text string) ([]float32, error) {
	e.entry.mu.Lock()
	defer e.entry.mu.Unlock()
	e.touchLocked()
	return e.entry.embedder.EmbedQuery(text)
}

func (e *runtimeEmbedder) EmbedBatch(texts []string) ([][]float32, error) {
	return e.EmbedDocumentBatch(texts)
}

func (e *runtimeEmbedder) EmbedDocumentBatch(texts []string) ([][]float32, error) {
	e.entry.mu.Lock()
	defer e.entry.mu.Unlock()
	e.touchLocked()
	return e.entry.embedder.EmbedDocumentBatch(texts)
}

func (e *runtimeEmbedder) EmbedQueryBatch(texts []string) ([][]float32, error) {
	e.entry.mu.Lock()
	defer e.entry.mu.Unlock()
	e.touchLocked()
	return e.entry.embedder.EmbedQueryBatch(texts)
}

func (e *runtimeEmbedder) Dimensions() int {
	e.entry.mu.Lock()
	defer e.entry.mu.Unlock()
	return e.entry.embedder.Dimensions()
}

func (e *runtimeEmbedder) ModelConfig() EmbeddingModelConfig {
	e.entry.mu.Lock()
	defer e.entry.mu.Unlock()
	return e.entry.embedder.ModelConfig()
}

func (e *runtimeEmbedder) GetTokenizer() Tokenizer {
	e.entry.mu.Lock()
	defer e.entry.mu.Unlock()
	return e.entry.embedder.GetTokenizer()
}

func (e *runtimeEmbedder) Close() {
	// Session callers may defer embedder.Close(); cached providers are owned by
	// SemanticRuntime and are closed only by idle unload or runtime shutdown.
}

func (e *runtimeEmbedder) touchLocked() {
	if e.runtime != nil {
		e.entry.lastUsed = e.runtime.now().UTC()
		return
	}
	e.entry.lastUsed = time.Now().UTC()
}

func loadSemanticRuntimeConfig(store *storage.Store) (semanticRuntimeConfig, error) {
	cfg, err := store.Config.Load()
	if err != nil {
		return semanticRuntimeConfig{}, fmt.Errorf("load config: %w", err)
	}
	if cfg == nil || cfg.Settings.SemanticSearch == nil || !cfg.Settings.SemanticSearch.Enabled || cfg.Settings.SemanticSearch.Model == "" {
		return semanticRuntimeConfig{}, ErrSemanticNotConfigured
	}
	// Resolved per spec ollama-only-embedding D1/FR-3: provider: local (or
	// omitted) behaves as provider: ollama with the D2 default model, in
	// memory only — config.json is untouched here.
	ss := cfg.Settings.EffectiveSemanticSearch()
	provider := ss.Provider
	if provider == "" {
		provider = "ollama"
	}
	return semanticRuntimeAPIConfig(ss, provider)
}

func semanticRuntimeAPIConfig(ss *models.SemanticSearchSettings, providerType string) (semanticRuntimeConfig, error) {
	settings, err := storage.NewEmbeddingSettingsStore().Load()
	if err != nil {
		return semanticRuntimeConfig{}, fmt.Errorf("load embedding settings: %w", err)
	}
	model, err := settings.GetModel(ss.Model)
	if err != nil {
		return semanticRuntimeConfig{}, fmt.Errorf("resolve embedding model: %w", err)
	}
	provider, err := settings.GetProvider(model.Provider)
	if err != nil {
		return semanticRuntimeConfig{}, fmt.Errorf("resolve embedding provider: %w", err)
	}
	provider = provider.WithDefaults()
	// Project settings win over the machine-wide registry so one project can
	// chunk differently without editing global state; the registry entry is the
	// fallback, and only then the embedder's own conservative default.
	maxTokens := ss.MaxTokens
	if maxTokens <= 0 {
		maxTokens = model.MaxTokens
	}
	// Every field below feeds the cache key. A changed prefix or context limit
	// produces different vectors and different chunk boundaries, so a runtime
	// cached under the old value must not be reused.
	key := strings.Join([]string{
		"provider=" + providerType,
		"providerID=" + model.Provider,
		"apiBase=" + provider.APIBase,
		"apiKey=" + secretFingerprint(provider.APIKey),
		"model=" + model.Model,
		"dims=" + strconv.Itoa(model.Dimensions),
		"maxTokens=" + strconv.Itoa(maxTokens),
		"queryPrefix=" + model.QueryPrefix,
		"docPrefix=" + model.DocPrefix,
		"timeout=" + strconv.Itoa(provider.Timeout),
		"batch=" + strconv.Itoa(provider.BatchSize),
		"retry=" + strconv.Itoa(provider.Retry.MaxRetries) + "/" + strconv.Itoa(provider.Retry.InitialDelay) + "/" + strconv.Itoa(provider.Retry.MaxDelay),
	}, "|")
	return semanticRuntimeConfig{
		cacheKey:         key,
		provider:         providerType,
		providerIdentity: model.Provider + "@" + provider.APIBase,
		modelID:          ss.Model,
		modelName:        model.Model,
		dimensions:       model.Dimensions,
		apiConfig: APIEmbedderConfig{
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
		},
	}, nil
}

func openSemanticRuntimeEmbedder(cfg semanticRuntimeConfig) (EmbedderProvider, error) {
	return NewAPIEmbedder(cfg.apiConfig)
}

func openRuntimeVectorStore(store *storage.Store, cfg semanticRuntimeConfig) (VectorStore, error) {
	if resolveEffectiveVectorStore(store).Backend == models.SemanticVectorBackendQdrant {
		if openQdrantVectorStoreOverride != nil {
			return openQdrantVectorStoreOverride(store, cfg.modelID, cfg.dimensions)
		}
		if pointer, err := LoadQdrantPointer(store.Root); err == nil && pointer == nil && LegacySQLiteIndexExists(store.Root) {
			legacy := NewSQLiteVectorStore(filepath.Join(store.Root, ".search"), cfg.modelID, cfg.dimensions)
			if err := legacy.Load(); err != nil {
				return nil, fmt.Errorf("load temporary legacy SQLite fallback: %w", err)
			}
			return legacy, nil
		}
		return OpenQdrantVectorStore(store, cfg.modelID, cfg.dimensions)
	}
	searchDir := filepath.Join(store.Root, ".search")
	vecStore := NewSQLiteVectorStore(searchDir, cfg.modelID, cfg.dimensions)
	if err := vecStore.Load(); err != nil {
		return nil, fmt.Errorf("load vector store: %w", err)
	}
	return vecStore, nil
}

func semanticRuntimeDisabledReason() (bool, string) {
	if v := strings.TrimSpace(os.Getenv("KNOWNS_SEMANTIC_RUNTIME_DISABLED")); v != "" && envBool(v) {
		return true, "KNOWNS_SEMANTIC_RUNTIME_DISABLED"
	}
	if v := strings.TrimSpace(os.Getenv("KNOWNS_SEMANTIC_RUNTIME")); v != "" {
		switch strings.ToLower(v) {
		case "0", "false", "off", "disabled", "disable":
			return true, "KNOWNS_SEMANTIC_RUNTIME"
		}
	}
	return false, ""
}

func semanticRuntimeIdleTimeout() time.Duration {
	if raw := strings.TrimSpace(os.Getenv("KNOWNS_SEMANTIC_RUNTIME_IDLE_TIMEOUT_MS")); raw != "" {
		if ms, err := strconv.Atoi(raw); err == nil && ms > 0 {
			return time.Duration(ms) * time.Millisecond
		}
	}
	return defaultSemanticRuntimeIdleTimeout
}

func envBool(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on", "enabled":
		return true
	default:
		return false
	}
}

func secretFingerprint(secret string) string {
	if secret == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:8])
}
