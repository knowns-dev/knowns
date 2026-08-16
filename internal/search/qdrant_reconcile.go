package search

// Targeted Qdrant reconciliation is deliberately separate from generation
// building. It consumes a durable, content-free lifecycle intent, proves that
// the current pointer still owns a reachable compatible collection, rereads
// canonical state, then deletes exact old sources and upserts only the
// affected entity's chunks.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/runtimequeue"
	"github.com/howznguyen/knowns/internal/storage"
)

const qdrantWatermarkFile = "qdrant-index-watermarks.json"

type QdrantIndexWatermark struct {
	EntityType      string    `json:"entityType"`
	EntityID        string    `json:"entityId"`
	CanonicalHash   string    `json:"canonicalHash,omitempty"`
	IndexedHash     string    `json:"indexedHash,omitempty"`
	Revision        int       `json:"revision,omitempty"`
	Path            string    `json:"path,omitempty"`
	IndexedRevision int       `json:"indexedRevision,omitempty"`
	IndexedPath     string    `json:"indexedPath,omitempty"`
	IndexedAt       time.Time `json:"indexedAt,omitempty"`
	Stale           bool      `json:"stale,omitempty"`
	Removed         bool      `json:"removed,omitempty"`
	PendingRemoval  bool      `json:"pendingRemoval,omitempty"`
}

// QdrantEntityReadiness is safe for status output: hashes and identity only;
// it contains no source content, endpoint, or credential.
type QdrantEntityReadiness struct {
	EntityType      string `json:"entityType"`
	EntityID        string `json:"entityId"`
	CanonicalHash   string `json:"canonicalHash,omitempty"`
	IndexedHash     string `json:"indexedHash,omitempty"`
	Revision        int    `json:"revision,omitempty"`
	IndexedRevision int    `json:"indexedRevision,omitempty"`
	Path            string `json:"path,omitempty"`
	IndexedPath     string `json:"indexedPath,omitempty"`
	Stale           bool   `json:"stale"`
}

func qdrantWatermarkPath(storeRoot string) string {
	return filepath.Join(storeRoot, "history", "state", qdrantWatermarkFile)
}

func loadQdrantWatermarks(storeRoot string) (map[string]QdrantIndexWatermark, error) {
	data, err := os.ReadFile(qdrantWatermarkPath(storeRoot))
	if errors.Is(err, os.ErrNotExist) {
		return map[string]QdrantIndexWatermark{}, nil
	}
	if err != nil {
		return nil, err
	}
	var values map[string]QdrantIndexWatermark
	if err := json.Unmarshal(data, &values); err != nil {
		return nil, fmt.Errorf("parse qdrant index watermarks: %w", err)
	}
	if values == nil {
		values = map[string]QdrantIndexWatermark{}
	}
	for key, value := range values {
		// Older records stored only desired revision/path. When an indexed hash
		// exists those fields also describe the indexed state.
		if value.IndexedHash != "" && value.IndexedRevision == 0 {
			value.IndexedRevision, value.IndexedPath = value.Revision, value.Path
			values[key] = value
		}
	}
	return values, nil
}

// LoadQdrantIndexWatermarks returns metadata-only per-entity index state.
func LoadQdrantIndexWatermarks(storeRoot string) (map[string]QdrantIndexWatermark, error) {
	return loadQdrantWatermarks(storeRoot)
}

func saveQdrantWatermarks(storeRoot string, values map[string]QdrantIndexWatermark) error {
	if values == nil {
		values = map[string]QdrantIndexWatermark{}
	}
	data, err := json.MarshalIndent(values, "", "  ")
	if err != nil {
		return err
	}
	path := qdrantWatermarkPath(storeRoot)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".qdrant-watermark-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err = tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err = tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	if err = os.Rename(tmpName, path); err != nil {
		return err
	}
	return nil
}

// QdrantEntityReadinessForStore compares canonical manifest hashes and
// durable public-hook intent watermarks with indexed watermarks without
// loading entity content. Public hooks do not necessarily update the watcher
// manifest, so their pending canonical state must remain observable while an
// unavailable Qdrant job retries.
func QdrantEntityReadinessForStore(storeRoot string) ([]QdrantEntityReadiness, error) {
	watermarks, err := loadQdrantWatermarks(storeRoot)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(filepath.Join(storeRoot, "history", "state", "manifest.json"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	var manifest struct {
		Entries map[string]struct {
			EntityType string `json:"entityType"`
			EntityID   string `json:"entityId"`
			Path       string `json:"path"`
			Hash       string `json:"hash"`
			Revision   int    `json:"revision"`
		} `json:"entries"`
	}
	if len(data) > 0 {
		if err := json.Unmarshal(data, &manifest); err != nil {
			return nil, err
		}
	}
	keysByID := make(map[string]struct{}, len(manifest.Entries)+len(watermarks))
	for key := range manifest.Entries {
		keysByID[key] = struct{}{}
	}
	for key, watermark := range watermarks {
		manifestEntry, inManifest := manifest.Entries[key]
		if watermark.Removed && inManifest && watermark.Revision >= manifestEntry.Revision {
			delete(keysByID, key)
			continue
		}
		if !watermark.Removed && watermark.EntityType != "" && watermark.EntityID != "" {
			keysByID[key] = struct{}{}
		}
	}
	keys := make([]string, 0, len(keysByID))
	for key := range keysByID {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]QdrantEntityReadiness, 0, len(keys))
	for _, key := range keys {
		entry, fromManifest := manifest.Entries[key]
		wm := watermarks[key]
		if fromManifest && wm.EntityID != "" {
			if wm.Revision > entry.Revision {
				entry.EntityType, entry.EntityID, entry.Path, entry.Hash, entry.Revision = wm.EntityType, wm.EntityID, wm.Path, wm.CanonicalHash, wm.Revision
				fromManifest = false
			} else if wm.Revision == entry.Revision && wm.CanonicalHash != "" && entry.Hash != "" && wm.CanonicalHash != entry.Hash {
				return nil, fmt.Errorf("qdrant readiness conflicting canonical hashes for %s revision %d", key, entry.Revision)
			}
		}
		if !fromManifest {
			entry.EntityType, entry.EntityID, entry.Path, entry.Hash, entry.Revision = wm.EntityType, wm.EntityID, wm.Path, wm.CanonicalHash, wm.Revision
		}
		out = append(out, QdrantEntityReadiness{EntityType: entry.EntityType, EntityID: entry.EntityID, CanonicalHash: entry.Hash, IndexedHash: wm.IndexedHash, Revision: entry.Revision, IndexedRevision: wm.IndexedRevision, Path: entry.Path, IndexedPath: wm.IndexedPath, Stale: wm.Stale || wm.PendingRemoval || entry.Hash == "" || wm.IndexedHash != entry.Hash || wm.IndexedRevision != entry.Revision || wm.IndexedPath != entry.Path})
	}
	return out, nil
}

func ExecuteQdrantReconciliation(ctx context.Context, storeRoot string, intent runtimequeue.QdrantIntent) error {
	if ctx == nil {
		ctx = context.Background()
	}
	store := storage.NewStore(storeRoot)
	current, err := proveQdrantIntent(storeRoot, intent)
	if err != nil {
		return err
	}
	if !current {
		// A newer history/manifest head superseded this durable job. The queue
		// coalescer retains a newer running successor when one exists.
		return nil
	}
	resolved := resolveEffectiveVectorStore(store)
	if !resolved.Enabled || resolved.Backend != models.SemanticVectorBackendQdrant {
		return nil // SQLite/keyword fallback remains unaffected.
	}
	pointer, err := LoadQdrantPointer(storeRoot)
	if err != nil {
		return err
	}
	client, err := qdrantClientForStore(store)
	if err != nil {
		return err
	}
	if err := validateTargetedCollection(ctx, store, pointer, client); err != nil {
		return err
	}
	session, err := InitSemanticRuntimeSession(store)
	if err != nil {
		return err
	}
	defer session.Close()
	qstore, ok := session.VecStore.(*QdrantVectorStore)
	if !ok || qstore == nil {
		return fmt.Errorf("targeted reconciliation requires active Qdrant vector store")
	}
	// Reread canonical state after pointer validation. A newer durable history
	// head supersedes this intent and must never be overwritten.
	var chunks []Chunk
	var sourceID string
	var canonicalHash string
	var semanticHash string
	switch intent.EntityType {
	case "task":
		task, getErr := store.Tasks.Get(intent.EntityID)
		if intent.Operation == "delete" || intent.Operation == "hard_delete" {
			return reconcileQdrantDelete(ctx, pointer, client, storeRoot, intent, "task:"+intent.EntityID)
		}
		if getErr != nil {
			return getErr
		}
		canonicalHash = storage.CanonicalTaskHash(task)
		semanticHash = contentHash(taskContentForHash(task))
		if intent.CanonicalHash != "" && canonicalHash != intent.CanonicalHash {
			return fmt.Errorf("qdrant intent stale for task %s", intent.EntityID)
		}
		chunks, err = qstore.embedTask(task, session.Embedder)
		sourceID = "task:" + intent.EntityID
	case "doc":
		if intent.Operation == "delete" || intent.Operation == "hard_delete" {
			return reconcileQdrantDelete(ctx, pointer, client, storeRoot, intent, "doc:"+intent.Path)
		}
		docPath, pathErr := normalizeIntentDocPath(intent.Path)
		if pathErr != nil {
			return pathErr
		}
		doc, getErr := store.Docs.Get(docPath)
		if getErr != nil {
			return getErr
		}
		canonicalHash = storage.CanonicalDocHash(doc)
		semanticHash = contentHash(doc.Title + "\n" + doc.Description + "\n" + doc.Content)
		if intent.CanonicalHash != "" && canonicalHash != intent.CanonicalHash {
			return fmt.Errorf("qdrant intent stale for doc %s", intent.Path)
		}
		chunks, err = qstore.embedDoc(doc, session.Embedder)
		sourceID = "doc:" + docPath
	default:
		return fmt.Errorf("unsupported qdrant entity type %q", intent.EntityType)
	}
	if err != nil {
		return err
	}
	previousSource := ""
	if intent.Operation == "rename" && intent.PreviousPath != "" && intent.PreviousPath != intent.Path {
		previousPath, pathErr := normalizeIntentDocPath(intent.PreviousPath)
		if pathErr != nil {
			return pathErr
		}
		previousSource = "doc:" + previousPath
	}
	if err := reconcileQdrantSource(ctx, client, pointer.CollectionName, previousSource, sourceID, chunks, semanticHash); err != nil {
		return err
	}
	return updateQdrantWatermark(storeRoot, intent, canonicalHash)
}

func currentQdrantIntent(storeRoot, entityType, target string, remove bool, previousPath string) (runtimequeue.QdrantIntent, error) {
	data, err := os.ReadFile(filepath.Join(storeRoot, "history", "state", "manifest.json"))
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return runtimequeue.QdrantIntent{}, err
		}
		data = []byte(`{"entries":{}}`)
	}
	var manifest struct {
		Entries map[string]struct {
			EntityType string `json:"entityType"`
			EntityID   string `json:"entityId"`
			Path       string `json:"path"`
			Hash       string `json:"hash"`
			Revision   int    `json:"revision"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		return runtimequeue.QdrantIntent{}, err
	}
	var found struct {
		EntityType string
		EntityID   string
		Path       string
		Hash       string
		Revision   int
	}
	for _, entry := range manifest.Entries {
		if entityType == "task" && entry.EntityID == target && entry.EntityType == entityType {
			found.EntityType, found.EntityID, found.Path, found.Hash, found.Revision = entry.EntityType, entry.EntityID, entry.Path, entry.Hash, entry.Revision
			break
		}
		if entityType == "doc" && entry.EntityType == entityType && (entry.Path == target || entry.Path == "docs/"+target+".md") {
			found.EntityType, found.EntityID, found.Path, found.Hash, found.Revision = entry.EntityType, entry.EntityID, entry.Path, entry.Hash, entry.Revision
			break
		}
	}
	if found.EntityID == "" {
		// Public mutation hooks can commit canonical/history state without
		// touching the filesystem manifest. Build a content-free current intent
		// from canonical storage plus the durable history head; proof below
		// revalidates both before any backend mutation.
		store := storage.NewStore(storeRoot)
		if entityType == "task" {
			task, taskErr := store.Tasks.Get(target)
			stream, historyErr := storage.NewHistoryStore(storeRoot).Read(context.Background(), "task", target)
			if taskErr == nil && historyErr == nil && len(stream.Records) > 0 {
				head := stream.Records[len(stream.Records)-1]
				if remove {
					return removalIntentFromHistoryOrPurge(storeRoot, "task", target, "tasks/"+target+".md", "")
				}
				return runtimequeue.QdrantIntent{EntityType: "task", EntityID: target, Revision: head.Revision, Operation: "update", CanonicalHash: storage.CanonicalTaskHash(task), Path: "tasks/" + target + ".md", BatchID: "public-hook"}, nil
			}
		}
		if entityType == "doc" {
			doc, docErr := store.Docs.Get(target)
			if docErr == nil && doc.ID != "" {
				stream, historyErr := storage.NewHistoryStore(storeRoot).Read(context.Background(), "doc", doc.ID)
				if historyErr == nil && len(stream.Records) > 0 {
					head := stream.Records[len(stream.Records)-1]
					if remove {
						return removalIntentFromHistoryOrPurge(storeRoot, "doc", doc.ID, "docs/"+doc.Path+".md", "")
					}
					return runtimequeue.QdrantIntent{EntityType: "doc", EntityID: doc.ID, Revision: head.Revision, Operation: "update", CanonicalHash: storage.CanonicalDocHash(doc), Path: "docs/" + doc.Path + ".md", BatchID: "public-hook"}, nil
				}
			}
		}
		if remove {
			return removalIntentFromHistoryOrPurge(storeRoot, entityType, target, targetPathForIntent(entityType, target), "")
		}
		return runtimequeue.QdrantIntent{}, fmt.Errorf("canonical %s intent target not found", entityType)
	}
	if remove {
		return removalIntentFromHistoryOrPurge(storeRoot, found.EntityType, found.EntityID, found.Path, previousPath)
	}
	return runtimequeue.QdrantIntent{EntityType: found.EntityType, EntityID: found.EntityID, Revision: found.Revision, Operation: "update", CanonicalHash: found.Hash, Path: found.Path, PreviousPath: previousPath}, nil
}

// currentPublicQdrantIntent intentionally derives revision/hash from current
// canonical storage and the durable history head, never from a watcher
// manifest which can lag public mutations. The manifest is used only as a
// last-resort Doc identity lookup after a deletion has removed canonical data.
func currentPublicQdrantIntent(storeRoot, entityType, target string, remove bool) (runtimequeue.QdrantIntent, error) {
	store := storage.NewStore(storeRoot)
	if entityType == "task" {
		if remove {
			intent, err := removalIntentFromHistoryOrPurge(storeRoot, "task", target, targetPathForIntent("task", target), "")
			intent.BatchID = "public-hook"
			return intent, err
		}
		task, err := store.Tasks.Get(target)
		if err != nil {
			return runtimequeue.QdrantIntent{}, err
		}
		stream, err := storage.NewHistoryStore(storeRoot).Read(context.Background(), "task", target)
		if err != nil || len(stream.Records) == 0 {
			return runtimequeue.QdrantIntent{}, fmt.Errorf("public task intent lacks durable history")
		}
		head := stream.Records[len(stream.Records)-1]
		return runtimequeue.QdrantIntent{EntityType: "task", EntityID: target, Revision: head.Revision, Operation: "update", CanonicalHash: storage.CanonicalTaskHash(task), Path: targetPathForIntent("task", target), BatchID: "public-hook"}, nil
	}
	if entityType != "doc" {
		return runtimequeue.QdrantIntent{}, fmt.Errorf("unsupported public qdrant entity type %q", entityType)
	}
	doc, docErr := store.Docs.Get(target)
	if docErr == nil && doc.ID != "" {
		if remove {
			intent, err := removalIntentFromHistoryOrPurge(storeRoot, "doc", doc.ID, "docs/"+doc.Path+".md", "")
			intent.BatchID = "public-hook"
			return intent, err
		}
		stream, err := storage.NewHistoryStore(storeRoot).Read(context.Background(), "doc", doc.ID)
		if err != nil || len(stream.Records) == 0 {
			return runtimequeue.QdrantIntent{}, fmt.Errorf("public doc intent lacks durable history")
		}
		head := stream.Records[len(stream.Records)-1]
		return runtimequeue.QdrantIntent{EntityType: "doc", EntityID: doc.ID, Revision: head.Revision, Operation: "update", CanonicalHash: storage.CanonicalDocHash(doc), Path: "docs/" + doc.Path + ".md", BatchID: "public-hook"}, nil
	}
	if remove {
		// Existing manifest identity may be stale but never supplies revision or hash.
		intent, err := currentQdrantIntent(storeRoot, "doc", target, true, "")
		intent.BatchID = "public-hook"
		return intent, err
	}
	return runtimequeue.QdrantIntent{}, docErr
}

func targetPathForIntent(entityType, target string) string {
	if entityType == "doc" {
		path := filepath.ToSlash(filepath.Clean(strings.TrimSpace(target)))
		if strings.HasPrefix(path, "docs/") {
			return path
		}
		return "docs/" + strings.TrimSuffix(path, ".md") + ".md"
	}
	return "tasks/" + target + ".md"
}

func removalIntentFromHistoryOrPurge(storeRoot, entityType, entityID, path, previousPath string) (runtimequeue.QdrantIntent, error) {
	base := runtimequeue.QdrantIntent{EntityType: entityType, EntityID: entityID, Operation: "hard_delete", Path: path, PreviousPath: previousPath}
	if ok, err := provePurgeReservation(storeRoot, base); err != nil {
		return runtimequeue.QdrantIntent{}, err
	} else if ok {
		return base, nil
	}
	// Public document removal jobs carry the old path rather than the stable
	// document ID. Resolve that path only through the exact durable purge
	// reservation; never guess an identity from a filename.
	if entityType == "doc" {
		if marker, ok, err := purgeReservationForPath(storeRoot, path); err != nil {
			return runtimequeue.QdrantIntent{}, err
		} else if ok {
			return runtimequeue.QdrantIntent{EntityType: "doc", EntityID: marker.EntityID, Operation: "hard_delete", CanonicalHash: firstNonEmptyIntentPath(marker.Hash, marker.ExpectedHash), Path: marker.Path}, nil
		}
	}
	stream, err := storage.NewHistoryStore(storeRoot).Read(context.Background(), entityType, entityID)
	if err != nil {
		return runtimequeue.QdrantIntent{}, err
	}
	if len(stream.Records) == 0 {
		return runtimequeue.QdrantIntent{}, fmt.Errorf("qdrant %s removal lacks durable tombstone or purge proof", entityType)
	}
	head := stream.Records[len(stream.Records)-1]
	if head.Operation != "delete" || !head.Tombstone {
		return runtimequeue.QdrantIntent{}, fmt.Errorf("qdrant %s removal lacks durable tombstone or purge proof", entityType)
	}
	intent := runtimequeue.QdrantIntent{EntityType: entityType, EntityID: entityID, Revision: head.Revision, Operation: "delete", CanonicalHash: head.NewHash, Path: firstNonEmptyIntentPath(head.CurrentPath, head.PreviousPath, path), PreviousPath: previousPath}
	return intent, nil
}

func purgeReservationForPath(storeRoot, path string) (struct {
	EntityID, Path, Hash, ExpectedHash string
}, bool, error) {
	var found struct {
		EntityID, Path, Hash, ExpectedHash string
	}
	entries, err := os.ReadDir(filepath.Join(storeRoot, "history", "purged"))
	if errors.Is(err, os.ErrNotExist) {
		return found, false, nil
	}
	if err != nil {
		return found, false, err
	}
	want := filepath.Clean(filepath.ToSlash(path))
	for _, file := range entries {
		if file.IsDir() || filepath.Ext(file.Name()) != ".json" {
			continue
		}
		data, readErr := os.ReadFile(filepath.Join(storeRoot, "history", "purged", file.Name()))
		if readErr != nil {
			continue
		}
		var marker struct {
			EntityType   string `json:"entityType"`
			EntityID     string `json:"entityId"`
			Path         string `json:"path"`
			Hash         string `json:"hash"`
			ExpectedHash string `json:"expectedHash"`
			Phase        string `json:"phase"`
		}
		if json.Unmarshal(data, &marker) != nil || marker.EntityType != "doc" || marker.Phase != "history_removed" || marker.EntityID == "" {
			continue
		}
		if filepath.Clean(filepath.ToSlash(marker.Path)) != want && filepath.Clean(filepath.ToSlash(strings.TrimPrefix(marker.Path, "docs/"))) != filepath.Clean(strings.TrimPrefix(want, "docs/")) {
			continue
		}
		found.EntityID, found.Path, found.Hash, found.ExpectedHash = marker.EntityID, marker.Path, marker.Hash, marker.ExpectedHash
		return found, true, nil
	}
	return found, false, nil
}

func firstNonEmptyIntentPath(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func validateTargetedCollection(ctx context.Context, store *storage.Store, pointer *QdrantPointer, client QdrantClient) error {
	if pointer == nil || pointer.Backend != models.SemanticVectorBackendQdrant || pointer.SchemaVersion != QdrantPointerSchemaVersion || pointer.ChunkVersion != ChunkVersion || pointer.CollectionUUID == "" || pointer.CollectionName != CollectionNameFromUUID(pointer.CollectionUUID) {
		return fmt.Errorf("qdrant active pointer is missing or malformed")
	}
	if _, err := uuid.Parse(pointer.CollectionUUID); err != nil {
		return fmt.Errorf("qdrant active pointer collectionUUID is invalid")
	}
	if pointer.Owner.StoreRootFingerprint != StoreRootFingerprint(store.Root) {
		return fmt.Errorf("qdrant active pointer ownership mismatch")
	}
	info, err := client.InspectCollection(ctx, pointer.CollectionName)
	if err != nil {
		return err
	}
	if !info.Exists {
		return fmt.Errorf("qdrant active collection is unavailable")
	}
	expectation := semanticIndexExpectationForStore(store)
	if expectation.model != "" && pointer.Embedding.Model != expectation.model {
		return fmt.Errorf("qdrant active collection model mismatch")
	}
	if expectation.dimensions > 0 && pointer.Embedding.Dimensions != expectation.dimensions {
		return fmt.Errorf("qdrant active pointer dimensions mismatch")
	}
	if info.Dimensions <= 0 || pointer.Embedding.Dimensions != info.Dimensions {
		return fmt.Errorf("qdrant active collection dimensions mismatch")
	}
	if info.Status != "" && strings.EqualFold(info.Status, "red") {
		return fmt.Errorf("qdrant active collection is unhealthy")
	}
	if info.Distance != "" && !strings.EqualFold(info.Distance, pointer.Embedding.Distance) {
		return fmt.Errorf("qdrant active collection distance mismatch")
	}
	return nil
}

func deleteQdrantSource(ctx context.Context, client QdrantClient, collection, source string) error {
	deleter, ok := client.(qdrantSourceDeleter)
	if !ok {
		return fmt.Errorf("qdrant client does not support exact source deletion")
	}
	return deleter.DeletePointsBySource(ctx, collection, source)
}

func reconcileQdrantSource(ctx context.Context, client QdrantClient, collection, previousSource, source string, chunks []Chunk, semanticHash string) error {
	if previousSource != "" && previousSource != source {
		if err := deleteQdrantSource(ctx, client, collection, previousSource); err != nil {
			return err
		}
	}
	if err := deleteQdrantSource(ctx, client, collection, source); err != nil {
		return err
	}
	points := make([]QdrantPoint, 0, len(chunks))
	for _, chunk := range chunks {
		points = append(points, QdrantPointFromChunk(chunk, semanticHash))
	}
	return client.UpsertPoints(ctx, collection, points)
}

func reconcileQdrantDelete(ctx context.Context, pointer *QdrantPointer, client QdrantClient, storeRoot string, intent runtimequeue.QdrantIntent, source string) error {
	if intent.EntityType == "doc" {
		path, err := normalizeIntentDocPath(intent.Path)
		if err != nil {
			return err
		}
		source = "doc:" + path
	}
	if err := deleteQdrantSource(ctx, client, pointer.CollectionName, source); err != nil {
		return err
	}
	if intent.PreviousPath != "" && intent.PreviousPath != intent.Path {
		previousPath, err := normalizeIntentDocPath(intent.PreviousPath)
		if err != nil {
			return err
		}
		if err := deleteQdrantSource(ctx, client, pointer.CollectionName, "doc:"+previousPath); err != nil {
			return err
		}
	}
	return updateQdrantWatermark(storeRoot, intent, "")
}

func normalizeIntentDocPath(path string) (string, error) {
	raw := filepath.ToSlash(strings.TrimSpace(path))
	if filepath.IsAbs(raw) || !strings.HasPrefix(raw, "docs/") || !strings.HasSuffix(raw, ".md") {
		return "", fmt.Errorf("invalid canonical doc path")
	}
	path = strings.TrimSuffix(strings.TrimPrefix(raw, "docs/"), ".md")
	path = filepath.ToSlash(filepath.Clean(path))
	if path == "" || path == "." || strings.HasPrefix(path, "../") || path == ".." || strings.Contains(path, "/../") {
		return "", fmt.Errorf("invalid canonical doc path")
	}
	return path, nil
}

// proveQdrantIntent checks local durable ownership before any backend call.
// It is intentionally metadata-only and treats a superseded intent as a
// successful no-op so a stale delete can never erase a restored entity.
func proveQdrantIntent(storeRoot string, intent runtimequeue.QdrantIntent) (bool, error) {
	if intent.BatchID == "public-hook" {
		if intent.Operation == "delete" {
			return proveHistoryRemoval(storeRoot, intent)
		}
		if intent.Operation == "hard_delete" {
			return provePurgeReservation(storeRoot, intent)
		}
		return provePublicQdrantIntent(storeRoot, intent)
	}
	manifestPath := filepath.Join(storeRoot, "history", "state", "manifest.json")
	data, err := os.ReadFile(manifestPath)
	if errors.Is(err, os.ErrNotExist) {
		if intent.BatchID == "public-hook" {
			return provePublicQdrantIntent(storeRoot, intent)
		}
		if intent.Operation == "hard_delete" {
			return provePurgeReservation(storeRoot, intent)
		}
		if intent.Operation == "delete" {
			return proveHistoryRemoval(storeRoot, intent)
		}
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var manifest struct {
		Entries map[string]struct {
			EntityType string `json:"entityType"`
			EntityID   string `json:"entityId"`
			Path       string `json:"path"`
			Hash       string `json:"hash"`
			Revision   int    `json:"revision"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		return false, err
	}
	key := intent.EntityType + ":" + intent.EntityID
	entry, exists := manifest.Entries[key]
	deleteOp := intent.Operation == "delete" || intent.Operation == "hard_delete"
	if deleteOp {
		if exists {
			return false, nil
		}
	} else {
		path := intent.Path
		if intent.EntityType == "doc" {
			path = filepath.ToSlash(filepath.Clean(path))
		}
		if (!exists || entry.EntityType != intent.EntityType || entry.EntityID != intent.EntityID || entry.Path != path || (intent.CanonicalHash != "" && entry.Hash != intent.CanonicalHash) || (intent.Revision > 0 && entry.Revision != intent.Revision)) && intent.BatchID != "public-hook" {
			return false, nil
		}
	}
	if intent.BatchID == "public-hook" {
		return provePublicQdrantIntent(storeRoot, intent)
	}
	if intent.Operation == "hard_delete" {
		return provePurgeReservation(storeRoot, intent)
	}
	return proveHistoryRemoval(storeRoot, intent)
}

func proveHistoryRemoval(storeRoot string, intent runtimequeue.QdrantIntent) (bool, error) {
	historyPath := storage.NewHistoryStore(storeRoot).EntityPath(intent.EntityType, intent.EntityID)
	historyData, err := os.ReadFile(historyPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	var head struct {
		Revision  int    `json:"revision"`
		Operation string `json:"operation"`
		NewHash   string `json:"newHash"`
		Tombstone bool   `json:"tombstone"`
	}
	lines := strings.Split(strings.TrimSpace(string(historyData)), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if strings.TrimSpace(lines[i]) != "" {
			if err := json.Unmarshal([]byte(lines[i]), &head); err != nil {
				return false, err
			}
			break
		}
	}
	if intent.Revision > 0 && head.Revision != intent.Revision {
		return false, nil
	}
	if intent.Operation == "delete" && (head.Operation != "delete" || !head.Tombstone) {
		return false, nil
	}
	if intent.CanonicalHash != "" && head.NewHash != "" && head.NewHash != intent.CanonicalHash {
		return false, nil
	}
	return true, nil
}

func provePurgeReservation(storeRoot string, intent runtimequeue.QdrantIntent) (bool, error) {
	entries, err := os.ReadDir(filepath.Join(storeRoot, "history", "purged"))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	for _, file := range entries {
		if file.IsDir() || filepath.Ext(file.Name()) != ".json" {
			continue
		}
		data, readErr := os.ReadFile(filepath.Join(storeRoot, "history", "purged", file.Name()))
		if readErr != nil {
			continue
		}
		var marker struct {
			EntityType   string `json:"entityType"`
			EntityID     string `json:"entityId"`
			Path         string `json:"path"`
			Hash         string `json:"hash"`
			ExpectedHash string `json:"expectedHash"`
			Phase        string `json:"phase"`
		}
		if json.Unmarshal(data, &marker) != nil || marker.EntityType != intent.EntityType || marker.EntityID != intent.EntityID {
			continue
		}
		if marker.Phase != "history_removed" || (intent.Path != "" && marker.Path != "" && filepath.Clean(marker.Path) != filepath.Clean(intent.Path)) {
			continue
		}
		if intent.CanonicalHash != "" && marker.Hash != "" && marker.Hash != intent.CanonicalHash && marker.ExpectedHash != intent.CanonicalHash {
			continue
		}
		return true, nil
	}
	return false, nil
}

func provePublicQdrantIntent(storeRoot string, intent runtimequeue.QdrantIntent) (bool, error) {
	stream, err := storage.NewHistoryStore(storeRoot).Read(context.Background(), intent.EntityType, intent.EntityID)
	if err != nil || len(stream.Records) == 0 {
		return false, err
	}
	head := stream.Records[len(stream.Records)-1]
	if intent.Revision > 0 && head.Revision != intent.Revision {
		return false, nil
	}
	if intent.Operation == "delete" {
		return false, nil // public removal must use the durable lifecycle tombstone/purge proof
	}
	// A public hook may be queued after the manifest is absent. Its durable
	// history head and canonical object must still identify the exact same
	// semantic state; revision alone is insufficient because a rewrite can
	// retain or reuse a revision while changing content.
	if strings.TrimSpace(intent.CanonicalHash) == "" || strings.TrimSpace(head.NewHash) == "" || head.NewHash != intent.CanonicalHash {
		return false, nil
	}
	store := storage.NewStore(storeRoot)
	var canonicalHash string
	if intent.EntityType == "task" {
		task, getErr := store.Tasks.Get(intent.EntityID)
		if getErr != nil {
			return false, nil
		}
		canonicalHash = storage.CanonicalTaskHash(task)
	} else if intent.EntityType == "doc" {
		path, pathErr := normalizeIntentDocPath(intent.Path)
		if pathErr != nil {
			return false, pathErr
		}
		doc, getErr := store.Docs.Get(path)
		if getErr != nil {
			return false, nil
		}
		canonicalHash = storage.CanonicalDocHash(doc)
	} else {
		return false, nil
	}
	return canonicalHash == intent.CanonicalHash, nil
}

func updateQdrantWatermark(storeRoot string, intent runtimequeue.QdrantIntent, canonicalHash string) error {
	return withQdrantWatermarks(storeRoot, func(values map[string]QdrantIndexWatermark) error {
		key := intent.EntityType + ":" + intent.EntityID
		if current, exists := values[key]; exists {
			if current.Revision > intent.Revision {
				return nil
			}
			desiredHash := canonicalHash
			if intent.Operation == "delete" || intent.Operation == "hard_delete" {
				desiredHash = intent.CanonicalHash
			}
			if current.Revision == intent.Revision && current.CanonicalHash != "" && (current.CanonicalHash != desiredHash || (current.Path != "" && current.Path != intent.Path)) {
				return fmt.Errorf("qdrant watermark canonical hash conflict for %s revision %d", key, intent.Revision)
			}
		}
		values[key] = QdrantIndexWatermark{EntityType: intent.EntityType, EntityID: intent.EntityID, CanonicalHash: canonicalHash, IndexedHash: canonicalHash, Revision: intent.Revision, Path: intent.Path, IndexedRevision: intent.Revision, IndexedPath: intent.Path, IndexedAt: time.Now().UTC(), Stale: false}
		if intent.Operation == "delete" || intent.Operation == "hard_delete" {
			values[key] = QdrantIndexWatermark{EntityType: intent.EntityType, EntityID: intent.EntityID, CanonicalHash: intent.CanonicalHash, Revision: intent.Revision, Path: intent.Path, IndexedAt: time.Now().UTC(), Removed: true}
		}
		return nil
	})
}

// markQdrantIntentPending durably exposes an accepted public intent as stale
// before queueing it. A late completion for an older revision cannot replace
// this newer canonical state because updateQdrantWatermark refuses regressions.
func markQdrantIntentPending(storeRoot string, intent runtimequeue.QdrantIntent) error {
	if intent.CanonicalHash == "" && intent.Operation != "delete" && intent.Operation != "hard_delete" {
		return nil
	}
	return withQdrantWatermarks(storeRoot, func(values map[string]QdrantIndexWatermark) error {
		key := intent.EntityType + ":" + intent.EntityID
		current, exists := values[key]
		if exists && current.Revision > intent.Revision {
			return nil
		}
		if exists && current.Revision == intent.Revision && current.CanonicalHash != "" && (current.CanonicalHash != intent.CanonicalHash || (current.Path != "" && current.Path != intent.Path)) {
			return fmt.Errorf("qdrant watermark canonical hash conflict for %s revision %d", key, intent.Revision)
		}
		values[key] = QdrantIndexWatermark{EntityType: intent.EntityType, EntityID: intent.EntityID, CanonicalHash: intent.CanonicalHash, IndexedHash: current.IndexedHash, Revision: intent.Revision, Path: intent.Path, IndexedRevision: current.IndexedRevision, IndexedPath: current.IndexedPath, IndexedAt: current.IndexedAt, Stale: true, PendingRemoval: intent.Operation == "delete" || intent.Operation == "hard_delete"}
		return nil
	})
}

func withQdrantWatermarks(storeRoot string, mutate func(map[string]QdrantIndexWatermark) error) error {
	return storage.WithQdrantWatermarkLock(context.Background(), storeRoot, func() error {
		values, err := loadQdrantWatermarks(storeRoot)
		if err != nil {
			return err
		}
		if err := mutate(values); err != nil {
			return err
		}
		return saveQdrantWatermarks(storeRoot, values)
	})
}

func contentHashForChunks(chunks []Chunk) string {
	var b strings.Builder
	for _, c := range chunks {
		b.WriteString(c.ID)
		b.WriteByte('\x00')
		b.WriteString(c.Content)
		b.WriteByte('\x00')
	}
	return contentHash(b.String())
}

func (s *QdrantVectorStore) embedTask(task *models.Task, embedder EmbedderProvider) ([]Chunk, error) {
	maxTokens := 512
	if cfg, ok := EmbeddingModels[s.model]; ok {
		maxTokens = cfg.MaxTokens
	}
	result := ChunkTask(task, maxTokens, embedder.GetTokenizer())
	return embedderChunks(embedder, result.Chunks)
}

func (s *QdrantVectorStore) embedDoc(doc *models.Doc, embedder EmbedderProvider) ([]Chunk, error) {
	maxTokens := 512
	if cfg, ok := EmbeddingModels[s.model]; ok {
		maxTokens = cfg.MaxTokens
	}
	result := ChunkDocument(doc.Content, doc.Path, doc.Title, doc.Description, maxTokens, embedder.GetTokenizer())
	return embedderChunks(embedder, result.Chunks)
}

func embedderChunks(embedder EmbedderProvider, chunks []Chunk) ([]Chunk, error) {
	if len(chunks) == 0 {
		return chunks, nil
	}
	texts := make([]string, len(chunks))
	for i := range chunks {
		texts[i] = chunks[i].Content
	}
	vecs, err := embedder.EmbedDocumentBatch(texts)
	if err != nil || len(vecs) != len(chunks) {
		return nil, fmt.Errorf("embed targeted chunks: %w", err)
	}
	for i := range chunks {
		chunks[i].Embedding = vecs[i]
	}
	return chunks, nil
}
