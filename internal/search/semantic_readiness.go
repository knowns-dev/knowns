package search

// Backend-neutral semantic index readiness (spec: qdrant-default-vector-backend).
//
// The runtime preflight and the readiness/status reporting must never probe a
// specific backend (such as .search/index.db) directly. Instead they ask the
// configured semantic vector store for its readiness. This file implements
// that abstraction:
//
//   - SemanticIndexReadiness is the shared, exported status type.
//   - ResolveSemanticIndexReadiness is the entry point used by the readiness
//     package (and anything else that reports semantic state).
//   - Qdrant readiness is pointer-only for now (task 02): it validates
//     qdrant.json metadata and never contacts the Qdrant network.
//   - SQLite readiness is the legacy implementation (spec D4/FR-14) and stays
//     available as a fallback source during the migration window: when the
//     configured backend is qdrant but no active pointer exists yet, a fresh
//     legacy SQLite index still satisfies readiness until the store is
//     migrated (task 06).

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

// SemanticIndexReadiness is a backend-neutral report of one store's semantic
// index state. It describes the configured backend and provisioning mode,
// whether the index is ready or stale, and why it is degraded. No field here
// implies a specific backend; consumers must switch on Backend when they need
// backend-specific details.
type SemanticIndexReadiness struct {
	// Enabled reports whether semantic vector search is enabled for the store
	// after env/project/global/default resolution.
	Enabled bool `json:"enabled"`
	// OptedOut is true when semantic vector search was explicitly disabled
	// (env, project config, global config, or the "none" backend).
	OptedOut bool `json:"optedOut,omitempty"`
	// Backend is the resolved vector backend: "qdrant", "sqlite", or "none".
	Backend string `json:"backend,omitempty"`
	// Mode is the resolved provisioning mode: "managed" or "external".
	Mode string `json:"mode,omitempty"`

	// Ready reports whether the active semantic index is present, fresh, and
	// usable for semantic search.
	Ready bool `json:"ready"`
	// Stale reports an existing index whose embedding identity (model,
	// dimensions, or chunk version) no longer matches the configured runtime.
	Stale bool `json:"stale,omitempty"`
	// Degraded reports that semantic search is enabled but the active backend
	// is not ready, so callers must fall back to keyword results. It is also
	// set when the configured backend is qdrant but only a legacy SQLite index
	// is available during the migration window (spec D3/D4).
	Degraded bool `json:"degraded,omitempty"`

	// Model is the embedding model identity recorded by the index (pointer or
	// legacy SQLite metadata).
	Model string `json:"model,omitempty"`
	// Dimensions is the vector size recorded by the index.
	Dimensions int `json:"dimensions,omitempty"`
	// ChunkVersion is the chunking/embedding logic version recorded by the index.
	ChunkVersion int `json:"chunkVersion,omitempty"`
	// ChunkCount is the number of indexed chunks reported by the index.
	ChunkCount int64 `json:"chunkCount,omitempty"`
	// IndexedAt is the last time the index was written, when known.
	IndexedAt *time.Time `json:"indexedAt,omitempty"`
	// Reason is a machine-friendly explanation when Ready is false (or during
	// migration fallback).
	Reason string `json:"reason,omitempty"`
	// Entities reports metadata-only canonical/indexed hash readiness for
	// Task/Doc sources. It never includes content or backend credentials.
	Entities         []QdrantEntityReadiness `json:"entities,omitempty"`
	EntityStaleCount int                     `json:"entityStaleCount,omitempty"`
	// EntitiesOnlyStale reports that per-entity watermarks are the sole cause
	// of staleness: the active index metadata (model, dimensions, chunk
	// version, chunk count, ownership) is valid. Callers scoped to that
	// metadata must not report themselves as broken in this state, and the
	// repair is per-entity reconciliation rather than a collection rebuild.
	EntitiesOnlyStale bool `json:"entitiesOnlyStale,omitempty"`
}

// SemanticIndexIdentity is the configured embedding identity used to validate
// backend metadata. It contains no provider credentials or endpoint details.
type SemanticIndexIdentity struct {
	Model        string
	Dimensions   int
	ChunkVersion int
}

// ConfiguredSemanticIndexIdentity exposes the canonical configured semantic
// identity to read-only diagnostics without exposing runtime configuration.
func ConfiguredSemanticIndexIdentity(store *storage.Store) SemanticIndexIdentity {
	expectation := semanticIndexExpectationForStore(store)
	return SemanticIndexIdentity{Model: expectation.model, Dimensions: expectation.dimensions, ChunkVersion: ChunkVersion}
}

// semanticIndexExpectation is the configured embedding identity used to
// validate index metadata without opening an embedding provider.
type semanticIndexExpectation struct {
	model      string
	dimensions int
}

// ResolveSemanticIndexReadiness reports the backend-neutral semantic index
// readiness for a store using effective vector store resolution
// (env > project > global > defaults, spec qdrant-default-vector-backend).
// It performs local metadata checks only and never contacts a backend network
// service.
func ResolveSemanticIndexReadiness(store *storage.Store) SemanticIndexReadiness {
	res := resolveEffectiveVectorStore(store)
	base := SemanticIndexReadiness{
		Enabled:  res.Enabled,
		OptedOut: res.OptedOut,
		Backend:  res.Backend,
		Mode:     res.Mode,
	}
	if store == nil {
		return base
	}
	if !res.Enabled || res.Backend == models.SemanticVectorBackendNone {
		base.Reason = semanticDisabledReadinessReason(res)
		return base
	}

	expectation := semanticIndexExpectationForStore(store)
	var (
		r   SemanticIndexReadiness
		err error
	)
	switch res.Backend {
	case models.SemanticVectorBackendQdrant:
		r, err = semanticIndexReadinessQdrant(store, expectation, nil)
	case models.SemanticVectorBackendSQLite:
		r, err = semanticIndexReadinessSQLite(store, expectation, nil)
	default:
		base.Reason = fmt.Sprintf("unsupported semantic backend %q", res.Backend)
		return base
	}
	if err != nil {
		r.Ready = false
		r.Degraded = true
		r.Reason = err.Error()
	}
	r.Enabled = base.Enabled
	r.OptedOut = base.OptedOut
	r.Backend = base.Backend
	r.Mode = base.Mode
	return r
}

// resolveEffectiveVectorStore computes the effective semantic vector store for
// a store with env override > project config > global settings > defaults.
func resolveEffectiveVectorStore(store *storage.Store) models.SemanticVectorStoreResolution {
	project, global := semanticSearchSettingsForStore(store)
	return models.ResolveSemanticVectorStore(project, global, nil)
}

// semanticSearchSettingsForStore returns the project-level and global-level
// semantic search settings that apply to a store. The global settings come
// from the machine-level projectDefaults in ~/.knowns/settings.json.
func semanticSearchSettingsForStore(store *storage.Store) (*models.SemanticSearchSettings, *models.SemanticSearchSettings) {
	if store == nil {
		return nil, nil
	}
	var project *models.SemanticSearchSettings
	if cfg, err := store.Config.Load(); err == nil && cfg != nil {
		project = cfg.Settings.SemanticSearch
	}
	var global *models.SemanticSearchSettings
	if settings, err := storage.NewEmbeddingSettingsStore().Load(); err == nil && settings.ProjectDefaults != nil {
		global = settings.ProjectDefaults.Settings.SemanticSearch
	}
	return project, global
}

// semanticIndexExpectationForStore computes the configured embedding identity
// for a store. It prefers the resolved runtime config (provider-aware defaults)
// but never fails on embedding runtime availability; the raw project settings
// are used as a fallback.
func semanticIndexExpectationForStore(store *storage.Store) semanticIndexExpectation {
	if cfg, err := loadSemanticRuntimeConfig(store); err == nil {
		return semanticIndexExpectation{model: cfg.modelID, dimensions: cfg.dimensions}
	}
	if cfg, err := store.Config.Load(); err == nil && cfg != nil && cfg.Settings.SemanticSearch != nil {
		ss := cfg.Settings.SemanticSearch
		return semanticIndexExpectation{model: ss.Model, dimensions: ss.Dimensions}
	}
	return semanticIndexExpectation{}
}

func semanticDisabledReadinessReason(res models.SemanticVectorStoreResolution) string {
	switch {
	case res.Backend == models.SemanticVectorBackendNone:
		return "semantic vector search disabled (backend none)"
	case res.OptedOut:
		return "semantic vector search disabled"
	default:
		return "semantic vector search not configured"
	}
}

// semanticIndexReadinessQdrant reports Qdrant readiness from pointer metadata
// only (task 02 scope; spec D5/FR-4). The pointer is ready when it exists,
// belongs to this store, and its model/dimensions/chunkVersion match the
// configured runtime with a non-zero chunk count. When no pointer exists yet,
// the legacy SQLite index is consulted as a fallback readiness source during
// the migration window (spec D4/FR-14). chunkTypes restricts the legacy SQLite
// chunk-count check; pass nil to count all types.
func semanticIndexReadinessQdrant(store *storage.Store, expectation semanticIndexExpectation, chunkTypes []ChunkType) (SemanticIndexReadiness, error) {
	r := SemanticIndexReadiness{Backend: models.SemanticVectorBackendQdrant, Enabled: true}
	entities, entityErr := QdrantEntityReadinessForStore(store.Root)
	if entityErr != nil {
		r.Degraded = true
		r.Ready = false
		r.Reason = "qdrant entity watermark state is corrupt or unreadable"
		return r, nil
	}
	r.Entities = entities
	for _, entity := range entities {
		if entity.Stale {
			r.EntityStaleCount++
		}
	}

	pointer, err := LoadQdrantPointer(store.Root)
	if err != nil {
		return r, fmt.Errorf("read qdrant pointer: %w", err)
	}
	if pointer == nil {
		// No active Qdrant pointer yet. During the migration window the legacy
		// SQLite index is the only readiness source available; report it while
		// marking the state degraded so status surfaces the pending migration.
		legacy, legacyErr := semanticIndexReadinessSQLite(store, expectation, chunkTypes)
		legacy.Backend = models.SemanticVectorBackendQdrant
		legacy.Degraded = true
		legacy.Entities = r.Entities
		legacy.EntityStaleCount = r.EntityStaleCount
		if legacyErr != nil {
			// Real SQLite errors (corrupt/unreadable index) propagate so the
			// runtime preflight keeps its existing diagnostics.
			return legacy, legacyErr
		}
		if legacy.Reason == "" {
			legacy.Reason = "no qdrant pointer; using legacy sqlite index during migration"
		} else {
			legacy.Reason = "no qdrant pointer; " + legacy.Reason
		}
		return legacy, nil
	}

	r.Model = pointer.Embedding.Model
	r.Dimensions = pointer.Embedding.Dimensions
	r.ChunkVersion = pointer.ChunkVersion
	r.ChunkCount = pointer.ChunkCount
	r.IndexedAt = pointer.LastIndexedAt

	switch {
	case strings.TrimSpace(pointer.CollectionUUID) == "":
		r.Degraded = true
		r.Reason = "qdrant pointer is missing collectionUUID"
	case pointer.Backend != "" && pointer.Backend != models.SemanticVectorBackendQdrant:
		r.Stale = true
		r.Reason = fmt.Sprintf("qdrant pointer backend = %q, want %q", pointer.Backend, models.SemanticVectorBackendQdrant)
	case pointer.SchemaVersion != QdrantPointerSchemaVersion:
		r.Stale = true
		r.Reason = fmt.Sprintf("qdrant pointer schema version = %d, want %d", pointer.SchemaVersion, QdrantPointerSchemaVersion)
	case StoreRootFingerprint(store.Root) != pointer.Owner.StoreRootFingerprint:
		r.Stale = true
		r.Reason = "qdrant pointer owner fingerprint mismatch (pointer belongs to a different store)"
	case expectation.model != "" && pointer.Embedding.Model != expectation.model:
		r.Stale = true
		r.Reason = fmt.Sprintf("qdrant pointer model %q != configured model %q", pointer.Embedding.Model, expectation.model)
	case expectation.dimensions > 0 && pointer.Embedding.Dimensions != expectation.dimensions:
		r.Stale = true
		r.Reason = fmt.Sprintf("qdrant pointer dimensions %d != configured dimensions %d", pointer.Embedding.Dimensions, expectation.dimensions)
	case pointer.ChunkVersion != ChunkVersion:
		r.Stale = true
		r.Reason = fmt.Sprintf("qdrant pointer chunk version %d != current chunk version %d", pointer.ChunkVersion, ChunkVersion)
	case pointer.ChunkCount <= 0:
		r.Degraded = true
		r.Reason = "qdrant pointer exists but chunk count is zero (never indexed)"
	}
	if r.EntityStaleCount > 0 && !r.Stale && !r.Degraded {
		// Reaching here means every pointer-scoped check above passed, so the
		// entities are the only cause. Record that here rather than letting
		// callers re-derive it from the pointer fields and drift.
		r.Stale, r.EntitiesOnlyStale = true, true
		r.Reason = fmt.Sprintf("%d canonical Task/Doc entities are not indexed at their current hash", r.EntityStaleCount)
	}
	if r.Stale || r.Degraded {
		r.Ready = false
		if r.Reason == "" {
			r.Reason = "qdrant semantic index is not ready"
		}
		return r, nil
	}
	r.Ready = true
	return r, nil
}

// semanticIndexReadinessSQLite is the legacy readiness implementation for the
// temporary SQLite fallback (spec D4/FR-14). It preserves the existing
// model/dimensions/chunkVersion/chunk-count metadata checks. chunkTypes
// restricts the chunk-count check; pass nil to count all types.
func semanticIndexReadinessSQLite(store *storage.Store, expectation semanticIndexExpectation, chunkTypes []ChunkType) (SemanticIndexReadiness, error) {
	r := SemanticIndexReadiness{Backend: models.SemanticVectorBackendSQLite, Enabled: true}
	if store == nil {
		return r, fmt.Errorf("semantic sqlite readiness: store is nil")
	}
	dbPath := filepath.Join(store.Root, ".search", "index.db")
	if _, err := os.Stat(dbPath); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			r.Degraded = true
			r.Reason = "no legacy sqlite semantic index"
			return r, nil
		}
		return r, fmt.Errorf("stat sqlite index: %w", err)
	}
	// Runtime searches can preflight while the daemon is opening or migrating
	// the same SQLite index. Wait briefly for that writer instead of degrading
	// a valid concurrent semantic request with SQLITE_BUSY.
	db, err := sql.Open("sqlite", dbPath+"?mode=ro&_pragma=busy_timeout(5000)")
	if err != nil {
		return r, err
	}
	defer db.Close()

	meta, found, err := readSQLiteSemanticMetadata(db)
	if err != nil {
		return r, err
	}
	r.Model = meta.model
	r.Dimensions = meta.dimensions
	r.ChunkVersion = meta.chunkVersion
	r.ChunkCount = meta.chunkCount
	if !meta.indexedAt.IsZero() {
		indexedAt := meta.indexedAt
		r.IndexedAt = &indexedAt
	}
	if !found {
		r.Degraded = true
		r.Reason = "sqlite index is empty or missing metadata"
		return r, nil
	}

	count, err := semanticIndexChunkCount(db, chunkTypes)
	if err != nil {
		if strings.Contains(err.Error(), "no such table") {
			r.Degraded = true
			r.Reason = "sqlite index is empty or missing tables"
			return r, nil
		}
		return r, err
	}
	r.ChunkCount = int64(count)

	switch {
	case expectation.model != "" && meta.model != "" && meta.model != expectation.model:
		r.Stale = true
		r.Reason = fmt.Sprintf("sqlite index model %q != configured model %q", meta.model, expectation.model)
	case expectation.dimensions > 0 && meta.dimensions > 0 && meta.dimensions != expectation.dimensions:
		r.Stale = true
		r.Reason = fmt.Sprintf("sqlite index dimensions %d != configured dimensions %d", meta.dimensions, expectation.dimensions)
	case meta.chunkVersion != ChunkVersion:
		r.Stale = true
		r.Reason = fmt.Sprintf("sqlite index chunk version %d != current chunk version %d", meta.chunkVersion, ChunkVersion)
	case count <= 0:
		r.Degraded = true
		r.Reason = "sqlite semantic index has no indexed chunks"
	}
	if r.Stale || r.Degraded {
		r.Ready = false
		if r.Reason == "" {
			r.Reason = "sqlite semantic index is not ready"
		}
		return r, nil
	}
	r.Ready = true
	return r, nil
}

// sqliteSemanticMetadata is the metadata block read from a legacy index.db.
type sqliteSemanticMetadata struct {
	model        string
	dimensions   int
	chunkVersion int
	indexedAt    time.Time
	chunkCount   int64
}

// readSQLiteSemanticMetadata reads the semantic metadata keys from a legacy
// index.db. found is false when the metadata table is missing or empty, which
// callers treat as an empty/unusable index rather than a hard error.
func readSQLiteSemanticMetadata(db *sql.DB) (sqliteSemanticMetadata, bool, error) {
	rows, err := db.Query("SELECT key, value FROM metadata WHERE key IN ('model', 'dimensions', 'chunkVersion', 'indexedAt', 'chunkCount')")
	if err != nil {
		if strings.Contains(err.Error(), "no such table") {
			return sqliteSemanticMetadata{}, false, nil
		}
		return sqliteSemanticMetadata{}, false, err
	}
	defer rows.Close()

	var meta sqliteSemanticMetadata
	found := false
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return sqliteSemanticMetadata{}, false, err
		}
		found = true
		switch key {
		case "model":
			meta.model = value
		case "dimensions":
			meta.dimensions, _ = strconv.Atoi(value)
		case "chunkVersion":
			meta.chunkVersion, _ = strconv.Atoi(value)
		case "indexedAt":
			meta.indexedAt, _ = time.Parse(time.RFC3339, value)
		case "chunkCount":
			meta.chunkCount, _ = strconv.ParseInt(value, 10, 64)
		}
	}
	if err := rows.Err(); err != nil {
		return sqliteSemanticMetadata{}, false, err
	}
	return meta, found, nil
}
