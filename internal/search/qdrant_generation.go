package search

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

const DefaultQdrantGenerationTTL = 72 * time.Hour
const defaultQdrantGenerationLockTimeout = 30 * time.Second
const defaultQdrantGenerationLockStaleAfter = 30 * time.Minute

var qdrantGenerationLocks sync.Map

// QdrantGenerationResult describes a completed activation. HistoryError is
// non-nil only when the pointer is already durable; cleanup is deliberately
// skipped in that state because ownership history was not durably recorded.
type QdrantGenerationResult struct {
	Pointer        *QdrantPointer
	Previous       *QdrantPointer
	CleanupDeleted []string
	CleanupErrors  []error
	HistoryError   error
}

type QdrantGenerationOptions struct {
	Client               QdrantClient
	Now                  func() time.Time
	Progress             ReindexProgress
	RetentionGenerations int
	RetentionTTL         time.Duration
	LockTimeout          time.Duration
	LockStaleAfter       time.Duration
	HistoryWriter        func(string, []QdrantGenerationRecord) error
}

// ReindexQdrantGeneration rebuilds exclusively from canonical Knowns sources.
// It never opens or reads the legacy SQLite index.db.
func ReindexQdrantGeneration(ctx context.Context, store *storage.Store, embedder EmbedderProvider, opts QdrantGenerationOptions) (QdrantGenerationResult, error) {
	if store == nil || embedder == nil || opts.Client == nil {
		return QdrantGenerationResult{}, fmt.Errorf("qdrant generation requires store, embedder, and client")
	}
	lockValue, _ := qdrantGenerationLocks.LoadOrStore(store.Root, &sync.Mutex{})
	lock := lockValue.(*sync.Mutex)
	lock.Lock()
	defer lock.Unlock()
	releaseFileLock, err := acquireQdrantGenerationFileLock(ctx, store.Root, opts.LockTimeout, opts.LockStaleAfter)
	if err != nil {
		return QdrantGenerationResult{}, err
	}
	defer releaseFileLock()
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	if opts.RetentionTTL <= 0 {
		opts.RetentionTTL = DefaultQdrantGenerationTTL
	}
	if opts.RetentionGenerations < 0 {
		opts.RetentionGenerations = models.DefaultSemanticVectorRetentionGenerations
	}
	previous, err := LoadQdrantPointer(store.Root)
	if err != nil {
		return QdrantGenerationResult{}, err
	}
	embedding := QdrantEmbeddingPointer{Model: embedder.ModelConfig().Name, Dimensions: embedder.Dimensions(), Distance: QdrantDefaultDistance}
	if cfg, err := loadSemanticRuntimeConfig(store); err == nil {
		embedding.Provider, embedding.Model = cfg.provider, cfg.modelID
	}
	projectID := ""
	if project, loadErr := store.Config.Load(); loadErr == nil && project != nil {
		projectID = project.ID
	}
	next, err := NewQdrantPointer(store.Root, projectID, embedding)
	if err != nil {
		return QdrantGenerationResult{}, err
	}
	created := now().UTC()
	if err := opts.Client.CreateCollection(ctx, next.CollectionName, embedding.Dimensions); err != nil {
		return QdrantGenerationResult{}, fmt.Errorf("create next Qdrant generation: %w", err)
	}
	activated := false
	defer func() {
		if !activated {
			_ = opts.Client.DeleteCollection(context.Background(), next.CollectionName)
		}
	}()
	stage := newQdrantStageStore(embedding.Model)
	if err := NewIndexService(store, embedder, stage).Reindex(opts.Progress); err != nil {
		return QdrantGenerationResult{}, fmt.Errorf("build next Qdrant generation from canonical sources: %w", err)
	}
	points := stage.points()
	for _, p := range points {
		if payloadString(p.Payload, qdrantPayloadChunkID) == "" || payloadString(p.Payload, qdrantPayloadSourceID) == "" || payloadInt(p.Payload, qdrantPayloadChunkVersion) != ChunkVersion || payloadString(p.Payload, qdrantPayloadContentHash) == "" {
			return QdrantGenerationResult{}, fmt.Errorf("validate next Qdrant generation payload metadata: incomplete pointer payload")
		}
	}
	if err := opts.Client.UpsertPoints(ctx, next.CollectionName, points); err != nil {
		return QdrantGenerationResult{}, fmt.Errorf("upsert next Qdrant generation: %w", err)
	}
	info, err := opts.Client.InspectCollection(ctx, next.CollectionName)
	if err != nil {
		return QdrantGenerationResult{}, fmt.Errorf("inspect next Qdrant generation: %w", err)
	}
	exactCount, err := opts.Client.CountPoints(ctx, next.CollectionName)
	if err != nil {
		return QdrantGenerationResult{}, fmt.Errorf("count next Qdrant generation points: %w", err)
	}
	if !info.Exists || info.Dimensions != embedding.Dimensions || !strings.EqualFold(info.Distance, QdrantRESTDistanceCosine) || exactCount != int64(len(points)) {
		return QdrantGenerationResult{}, fmt.Errorf("validate next Qdrant generation: exists=%v dimensions=%d/%d distance=%q points=%d/%d", info.Exists, info.Dimensions, embedding.Dimensions, info.Distance, exactCount, len(points))
	}
	indexed := now().UTC()
	next.LastIndexedAt, next.ChunkCount = &indexed, int64(len(points))
	if err := SaveQdrantPointer(store.Root, next); err != nil {
		return QdrantGenerationResult{}, fmt.Errorf("activate next Qdrant generation: %w", err)
	}
	activated = true
	result := QdrantGenerationResult{Pointer: next, Previous: previous}
	records, historyErr := LoadQdrantGenerations(store.Root)
	if historyErr != nil {
		result.HistoryError = fmt.Errorf("active pointer was swapped but generation history could not be loaded; cleanup skipped: %w", historyErr)
		return result, result.HistoryError
	}
	generation := 1
	for _, r := range records {
		if r.Generation >= generation {
			generation = r.Generation + 1
		}
	}
	if previous != nil && generation == 1 {
		generation = 2
	}
	retired := indexed
	updatedPrevious := false
	for i := range records {
		if records[i].Status == QdrantGenerationStatusActive {
			records[i].Status, records[i].RetiredAt, records[i].SwappedAt = QdrantGenerationStatusInactive, &retired, indexed
			if previous != nil && records[i].CollectionName == previous.CollectionName {
				records[i] = generationRecord(records[i].Generation, previous, QdrantGenerationStatusInactive, records[i].CreatedAt, indexed, &retired)
				updatedPrevious = true
			}
		}
	}
	if previous != nil && !updatedPrevious {
		records = append(records, generationRecord(generation-1, previous, QdrantGenerationStatusInactive, created, indexed, &retired))
	}
	records = append(records, generationRecord(generation, next, QdrantGenerationStatusActive, created, indexed, nil))
	writer := opts.HistoryWriter
	if writer == nil {
		writer = SaveQdrantGenerations
	}
	if err := writer(store.Root, records); err != nil {
		result.HistoryError = fmt.Errorf("active pointer was swapped but generation history could not record active collection; cleanup skipped: %w", err)
		return result, result.HistoryError
	}
	deleted, cleanupErrs := CleanupQdrantGenerations(ctx, store.Root, opts.Client, next, opts.RetentionGenerations, opts.RetentionTTL, now().UTC())
	result.CleanupDeleted, result.CleanupErrors = deleted, cleanupErrs
	return result, nil
}

func qdrantGenerationLockPath(storeRoot string) string {
	return filepath.Join(storeRoot, ".search", "qdrant-reindex.lock")
}

func acquireQdrantGenerationFileLock(ctx context.Context, storeRoot string, timeout, staleAfter time.Duration) (func(), error) {
	if timeout <= 0 {
		timeout = defaultQdrantGenerationLockTimeout
	}
	if staleAfter <= 0 {
		staleAfter = defaultQdrantGenerationLockStaleAfter
	}
	path := qdrantGenerationLockPath(storeRoot)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	deadline := time.Now().Add(timeout)
	for {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			_, writeErr := fmt.Fprintf(f, "pid=%d\ncreatedAt=%s\n", os.Getpid(), time.Now().UTC().Format(time.RFC3339Nano))
			closeErr := f.Close()
			if writeErr != nil || closeErr != nil {
				_ = os.Remove(path)
				if writeErr != nil {
					return nil, writeErr
				}
				return nil, closeErr
			}
			return func() { _ = os.Remove(path) }, nil
		}
		if !os.IsExist(err) {
			return nil, err
		}
		// The lock records its holder's PID. A holder that died without
		// releasing (crash, SIGKILL, a killed `knowns` run) otherwise blocks
		// every reindex for the whole staleAfter window even though nothing is
		// rebuilding. Reclaim as soon as the PID is gone; PID reuse can only
		// make an abandoned lock look held, which the mtime check below still
		// clears on its own schedule.
		if holder, ok := qdrantGenerationLockHolder(path); ok && !isProcessAlive(holder) {
			_ = os.Remove(path)
			continue
		}
		if info, statErr := os.Stat(path); statErr == nil && time.Since(info.ModTime()) > staleAfter {
			_ = os.Remove(path)
			continue
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("timed out waiting for Qdrant generation lock %s", path)
		}
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("wait for Qdrant generation lock: %w", ctx.Err())
		case <-time.After(50 * time.Millisecond):
		}
	}
}

// qdrantGenerationLockHolder reads the PID that acquireQdrantGenerationFileLock
// recorded in a lock file. It reports false when the file is unreadable, racing
// a release, or was written without the pid line, so callers fall back to the
// mtime staleness window rather than assuming the lock is abandoned.
func qdrantGenerationLockHolder(path string) (int, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	for _, line := range strings.Split(string(data), "\n") {
		raw, found := strings.CutPrefix(strings.TrimSpace(line), "pid=")
		if !found {
			continue
		}
		pid, convErr := strconv.Atoi(strings.TrimSpace(raw))
		if convErr != nil || pid <= 0 {
			return 0, false
		}
		return pid, true
	}
	return 0, false
}

func generationRecord(generation int, p *QdrantPointer, status string, created, swapped time.Time, retired *time.Time) QdrantGenerationRecord {
	if generation < 1 {
		generation = 1
	}
	return QdrantGenerationRecord{Generation: generation, CollectionUUID: p.CollectionUUID, CollectionName: p.CollectionName, SchemaVersion: p.SchemaVersion, ChunkVersion: p.ChunkVersion, Embedding: p.Embedding, Owner: p.Owner, Status: status, ChunkCount: p.ChunkCount, CreatedAt: created, SwappedAt: swapped, RetiredAt: retired}
}

// CleanupQdrantGenerations applies D7's hard count cap before its TTL and
// deletes only records with an exact owner fingerprint match.
func CleanupQdrantGenerations(ctx context.Context, storeRoot string, client QdrantClient, active *QdrantPointer, keep int, ttl time.Duration, now time.Time) ([]string, []error) {
	if client == nil || active == nil || active.Owner.StoreRootFingerprint == "" {
		return nil, []error{errors.New("qdrant cleanup refused: positive ownership proof is missing")}
	}
	records, err := LoadQdrantGenerations(storeRoot)
	if err != nil {
		return nil, []error{err}
	}
	byName := map[string]QdrantGenerationRecord{}
	for _, r := range records {
		if r.Status == QdrantGenerationStatusInactive {
			byName[r.CollectionName] = r
		}
	}
	inactive := make([]QdrantGenerationRecord, 0, len(byName))
	for _, r := range byName {
		inactive = append(inactive, r)
	}
	sort.Slice(inactive, func(i, j int) bool { return inactive[i].Generation > inactive[j].Generation })
	var deleted []string
	var errs []error
	for i, r := range inactive {
		owned := r.Owner.StoreRootFingerprint == active.Owner.StoreRootFingerprint && r.Owner.StoreRootFingerprint == StoreRootFingerprint(storeRoot)
		if !owned {
			errs = append(errs, fmt.Errorf("qdrant cleanup refused for %s: ownership proof mismatch", r.CollectionName))
			continue
		}
		expired := r.RetiredAt != nil && !now.Before(r.RetiredAt.Add(ttl))
		if i < keep && !expired {
			continue
		}
		if err := client.DeleteCollection(ctx, r.CollectionName); err != nil {
			errs = append(errs, fmt.Errorf("delete inactive Qdrant generation %s: %w", r.CollectionName, err))
			continue
		}
		deleted = append(deleted, r.CollectionName)
	}
	// Record the deletions. A record left at "inactive" outlives the collection
	// it describes, so retention keeps counting it and diagnostics keep
	// proposing an already-dropped collection for manual review — advice no
	// operator can act on, because there is nothing left to drop.
	if len(deleted) > 0 {
		dropped := make(map[string]bool, len(deleted))
		for _, name := range deleted {
			dropped[name] = true
		}
		for i := range records {
			if dropped[records[i].CollectionName] && records[i].Status == QdrantGenerationStatusInactive {
				records[i].Status = QdrantGenerationStatusDeleted
			}
		}
		if err := SaveQdrantGenerations(storeRoot, records); err != nil {
			errs = append(errs, fmt.Errorf("record deleted Qdrant generations: %w", err))
		}
	}
	return deleted, errs
}

// PurgeQdrantCollections bypasses retention but still fails closed unless
// every target is positively owned by the current store metadata.
func PurgeQdrantCollections(ctx context.Context, storeRoot string, client QdrantClient) ([]string, error) {
	pointer, err := LoadQdrantPointer(storeRoot)
	if err != nil {
		return nil, err
	}
	if pointer == nil || pointer.Owner.StoreRootFingerprint == "" || pointer.Owner.StoreRootFingerprint != StoreRootFingerprint(storeRoot) {
		return nil, fmt.Errorf("qdrant purge refused: positive ownership proof is missing")
	}
	records, err := LoadQdrantGenerations(storeRoot)
	if err != nil {
		return nil, err
	}
	targets := map[string]bool{pointer.CollectionName: true}
	for _, r := range records {
		if r.Owner.StoreRootFingerprint != pointer.Owner.StoreRootFingerprint {
			return nil, fmt.Errorf("qdrant purge refused for %s: ownership proof mismatch", r.CollectionName)
		}
		targets[r.CollectionName] = true
	}
	names := make([]string, 0, len(targets))
	for name := range targets {
		names = append(names, name)
	}
	sort.Strings(names)
	deleted := make([]string, 0, len(names))
	for _, name := range names {
		if err := client.DeleteCollection(ctx, name); err != nil {
			return deleted, fmt.Errorf("purge Qdrant collection %s after deleting %d collections: %w", name, len(deleted), err)
		}
		deleted = append(deleted, name)
	}
	return deleted, nil
}

type qdrantStageStore struct {
	mu     sync.Mutex
	model  string
	chunks []Chunk
	hashes map[string]string
}

func newQdrantStageStore(model string) *qdrantStageStore {
	return &qdrantStageStore{model: model, hashes: map[string]string{}}
}
func (s *qdrantStageStore) Load() error         { return nil }
func (s *qdrantStageStore) Save() error         { return nil }
func (s *qdrantStageStore) Clear() error        { s.chunks = nil; s.hashes = map[string]string{}; return nil }
func (s *qdrantStageStore) AddChunks(c []Chunk) { s.chunks = append(s.chunks, c...) }
func (s *qdrantStageStore) RemoveByPrefix(p string) {
	var out []Chunk
	for _, c := range s.chunks {
		if !strings.HasPrefix(c.ID, p) {
			out = append(out, c)
		}
	}
	s.chunks = out
}
func (s *qdrantStageStore) RemoveByIDs(ids []string) {
	m := map[string]bool{}
	for _, id := range ids {
		m[id] = true
	}
	var out []Chunk
	for _, c := range s.chunks {
		if !m[c.ID] {
			out = append(out, c)
		}
	}
	s.chunks = out
}
func (s *qdrantStageStore) Search([]float32, VectorSearchOpts) []ScoredChunk { return nil }
func (s *qdrantStageStore) Count() int                                       { return len(s.chunks) }
func (s *qdrantStageStore) NeedsRebuild(string) bool                         { return false }
func (s *qdrantStageStore) Stats() (int, string, time.Time) {
	return len(s.chunks), s.model, time.Time{}
}
func (s *qdrantStageStore) Close() error                         { return nil }
func (s *qdrantStageStore) Model() string                        { return s.model }
func (s *qdrantStageStore) GetContentHash(id string) string      { return s.hashes[id] }
func (s *qdrantStageStore) SetContentHash(id, h string)          { s.hashes[id] = h }
func (s *qdrantStageStore) DeleteContentHash(id string)          { delete(s.hashes, id) }
func (s *qdrantStageStore) ListContentHashes() map[string]string { return s.hashes }
func (s *qdrantStageStore) points() []QdrantPoint {
	out := make([]QdrantPoint, 0, len(s.chunks))
	for _, c := range s.chunks {
		source := SourceIDForChunk(c)
		out = append(out, QdrantPointFromChunk(c, s.hashes[source]))
	}
	return out
}

// LegacySQLiteIndexExists is only a migration trigger; generation rebuilds do
// not open or copy any rows from this file.
func LegacySQLiteIndexExists(storeRoot string) bool {
	_, err := os.Stat(QdrantLegacySQLitePath(storeRoot))
	return err == nil
}
func QdrantLegacySQLitePath(storeRoot string) string {
	return strings.Join([]string{strings.TrimRight(storeRoot, "/"), ".search", "index.db"}, string(os.PathSeparator))
}

func retentionFromResolution(res models.SemanticVectorStoreResolution) (int, time.Duration) {
	keep := models.DefaultSemanticVectorRetentionGenerations
	if res.Retention.PreviousGenerations != nil {
		keep = *res.Retention.PreviousGenerations
	}
	ttl := DefaultQdrantGenerationTTL
	if parsed, err := time.ParseDuration(res.Retention.PreviousGenerationTTL); err == nil {
		ttl = parsed
	}
	return keep, ttl
}
