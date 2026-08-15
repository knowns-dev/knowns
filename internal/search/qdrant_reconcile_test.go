package search

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/runtimequeue"
	"github.com/howznguyen/knowns/internal/storage"
)

type targetedFakeClient struct {
	info        QdrantCollectionInfo
	inspects    int
	deletes     []string
	upserts     [][]QdrantPoint
	collections int
	failUpsert  bool
}

func (f *targetedFakeClient) CreateCollection(context.Context, string, int) error {
	f.collections++
	return nil
}
func (f *targetedFakeClient) CollectionExists(context.Context, string) (bool, error) {
	return f.info.Exists, nil
}
func (f *targetedFakeClient) InspectCollection(context.Context, string) (QdrantCollectionInfo, error) {
	f.inspects++
	return f.info, nil
}
func (f *targetedFakeClient) CountPoints(context.Context, string) (int64, error) { return 0, nil }
func (f *targetedFakeClient) UpsertPoints(_ context.Context, _ string, points []QdrantPoint) error {
	if f.failUpsert {
		return os.ErrDeadlineExceeded
	}
	f.upserts = append(f.upserts, points)
	return nil
}
func (f *targetedFakeClient) Query(context.Context, string, []float32, QdrantQueryOptions) ([]ScoredChunk, error) {
	return nil, nil
}
func (f *targetedFakeClient) QueryValidated(context.Context, string, []float32, QdrantQueryOptions, QdrantHitValidationContext) ([]ScoredChunk, QdrantHitValidationSummary, error) {
	return nil, QdrantHitValidationSummary{}, nil
}
func (f *targetedFakeClient) DeletePoints(context.Context, string, []string) error { return nil }
func (f *targetedFakeClient) DeleteCollection(context.Context, string) error {
	f.collections++
	return nil
}
func (f *targetedFakeClient) DeletePointsBySource(_ context.Context, _ string, source string) error {
	f.deletes = append(f.deletes, source)
	return nil
}

func targetedPointer(t *testing.T, storeRoot string) *QdrantPointer {
	t.Helper()
	pointer, err := NewQdrantPointer(storeRoot, "", QdrantEmbeddingPointer{Provider: "local", Model: "gte-small", Dimensions: 384, Distance: "cosine"})
	if err != nil {
		t.Fatal(err)
	}
	pointer.LastIndexedAt = func() *time.Time { now := time.Now().UTC(); return &now }()
	return pointer
}

func TestTargetedCollectionValidationRejectsUnsafeMetadataWithoutWrites(t *testing.T) {
	store := configureSemanticStore(t, &models.SemanticVectorStoreSettings{Backend: models.SemanticVectorBackendQdrant})
	pointer := targetedPointer(t, store.Root)
	base := QdrantCollectionInfo{Name: pointer.CollectionName, Exists: true, Dimensions: 384, Distance: "cosine", Status: "green"}
	cases := []struct {
		name   string
		mutate func(*QdrantPointer, *QdrantCollectionInfo)
	}{
		{"owner", func(p *QdrantPointer, _ *QdrantCollectionInfo) { p.Owner.StoreRootFingerprint = "sha256:other" }},
		{"schema", func(p *QdrantPointer, _ *QdrantCollectionInfo) { p.SchemaVersion++ }},
		{"name", func(p *QdrantPointer, _ *QdrantCollectionInfo) { p.CollectionName = "kn_other" }},
		{"uuid", func(p *QdrantPointer, _ *QdrantCollectionInfo) {
			p.CollectionUUID = "not-a-uuid"
			p.CollectionName = CollectionNameFromUUID(p.CollectionUUID)
		}},
		{"model", func(p *QdrantPointer, _ *QdrantCollectionInfo) { p.Embedding.Model = "other" }},
		{"dimensions", func(p *QdrantPointer, info *QdrantCollectionInfo) { info.Dimensions = 128 }},
		{"chunk-version", func(p *QdrantPointer, _ *QdrantCollectionInfo) { p.ChunkVersion++ }},
		{"distance", func(p *QdrantPointer, info *QdrantCollectionInfo) { info.Distance = "dot" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := *pointer
			info := base
			tc.mutate(&p, &info)
			client := &targetedFakeClient{info: info}
			if err := validateTargetedCollection(context.Background(), store, &p, client); err == nil {
				t.Fatal("unsafe metadata accepted")
			}
			if len(client.upserts) != 0 || len(client.deletes) != 0 || client.collections != 0 {
				t.Fatalf("unsafe validation mutated Qdrant: %#v", client)
			}
		})
	}
}

func TestCurrentQdrantIntentUsesCanonicalHistoryWhenManifestIsMissing(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	if err := os.MkdirAll(filepath.Join(root, "tasks"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "tasks", "task-public - Public.md"), []byte("---\nid: public\ntitle: Public\nstatus: todo\npriority: medium\nlabels: []\n---\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	store := storage.NewStore(root)
	task, err := store.Tasks.Get("public")
	if err != nil {
		t.Fatal(err)
	}
	if err := storage.NewHistoryStore(root).Append(context.Background(), models.HistoryRecord{EntityType: "task", EntityID: "public", Operation: "update", NewHash: storage.CanonicalTaskHash(task), Checkpoint: true, CheckpointPayload: map[string]any{"id": "public", "title": "Public", "status": "todo", "priority": "medium"}}); err != nil {
		t.Fatal(err)
	}
	intent, err := currentQdrantIntent(root, "task", "public", false, "")
	if err != nil {
		t.Fatalf("public fallback intent: %v", err)
	}
	if intent.BatchID != "public-hook" || intent.Operation != "update" || intent.EntityID != "public" {
		t.Fatalf("fallback intent = %#v", intent)
	}
	if ok, proofErr := proveQdrantIntent(root, intent); proofErr != nil || !ok {
		t.Fatalf("manifest-free public update proof = %v, err=%v", ok, proofErr)
	}
	if err := os.WriteFile(filepath.Join(root, "tasks", "task-public - Public.md"), []byte("---\nid: public\ntitle: Changed\nstatus: todo\npriority: medium\nlabels: []\n---\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	mismatched, err := currentQdrantIntent(root, "task", "public", false, "")
	if err != nil {
		t.Fatal(err)
	}
	if ok, proofErr := proveQdrantIntent(root, mismatched); proofErr != nil || ok {
		t.Fatalf("canonical/history hash mismatch was accepted: proof=%v err=%v", ok, proofErr)
	}
	if err := os.WriteFile(filepath.Join(root, "tasks", "task-public - Public.md"), []byte("---\nid: public\ntitle: Public\nstatus: todo\npriority: medium\nlabels: []\n---\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := currentQdrantIntent(root, "task", "public", true, ""); err == nil {
		t.Fatal("ordinary public removal without tombstone was accepted")
	}
	hash := storage.CanonicalTaskHash(task)
	if err := storage.NewHistoryStore(root).Append(context.Background(), models.HistoryRecord{EntityType: "task", EntityID: "public", Operation: "delete", Tombstone: true, BaseHash: hash, NewHash: hash, Checkpoint: true, CheckpointPayload: map[string]any{"id": "public"}}); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(root, "tasks", "task-public - Public.md")); err != nil {
		t.Fatal(err)
	}
	intent, err = currentQdrantIntent(root, "task", "public", true, "")
	if err != nil || intent.Operation != "delete" {
		t.Fatalf("tombstone removal intent = %#v, err=%v", intent, err)
	}
	if ok, proofErr := proveQdrantIntent(root, intent); proofErr != nil || !ok {
		t.Fatalf("tombstone proof = %v, err=%v", ok, proofErr)
	}
}

func TestQdrantBestEffortTaskHookQueuesOnlyDurableIntent(t *testing.T) {
	store := configureSemanticStore(t, &models.SemanticVectorStoreSettings{Backend: models.SemanticVectorBackendQdrant})
	if err := os.MkdirAll(filepath.Join(store.Root, "tasks"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.Root, "tasks", "task-hook - Hook.md"), []byte("---\nid: hook\ntitle: Hook\nstatus: todo\npriority: medium\nlabels: []\n---\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	task, err := store.Tasks.Get("hook")
	if err != nil {
		t.Fatal(err)
	}
	if err := storage.NewHistoryStore(store.Root).Append(context.Background(), models.HistoryRecord{EntityType: "task", EntityID: "hook", Operation: "update", NewHash: storage.CanonicalTaskHash(task), Checkpoint: true, CheckpointPayload: map[string]any{"id": "hook", "title": "Hook", "status": "todo", "priority": "medium"}}); err != nil {
		t.Fatal(err)
	}
	BestEffortIndexTask(store, "hook")
	queue, err := runtimequeue.LoadQueue(store.Root)
	if err != nil {
		t.Fatal(err)
	}
	if len(queue.Jobs) != 1 || queue.Jobs[0].Kind != runtimequeue.JobQdrantReconcile || queue.Jobs[0].Intent == nil {
		t.Fatalf("qdrant best-effort queue = %#v, want one durable targeted intent", queue.Jobs)
	}
	BestEffortIndexTask(store, "missing")
	queue, err = runtimequeue.LoadQueue(store.Root)
	if err != nil {
		t.Fatal(err)
	}
	if len(queue.Jobs) != 1 {
		t.Fatalf("invalid qdrant hook created fallback job: %#v", queue.Jobs)
	}
}

func TestTargetedProofRejectsDeleteAfterRestoreAndWatermarkIsStableIdentity(t *testing.T) {
	root := t.TempDir()
	stateDir := filepath.Join(root, "history", "state")
	if err := os.MkdirAll(stateDir, 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := map[string]any{"schemaVersion": 1, "entries": map[string]any{
		"doc:doc-1": map[string]any{"entityType": "doc", "entityId": "doc-1", "path": "docs/new.md", "hash": "h2", "revision": 2},
	}}
	writeJSONTest(t, filepath.Join(stateDir, "manifest.json"), manifest)
	historyDir := filepath.Join(root, "history", "docs")
	if err := os.MkdirAll(historyDir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeJSONLTest(t, filepath.Join(historyDir, "doc-1.jsonl"), map[string]any{"revision": 2, "operation": "restore", "newHash": "h2"})
	current, err := proveQdrantIntent(root, runtimequeue.QdrantIntent{EntityType: "doc", EntityID: "doc-1", Revision: 1, Operation: "delete", CanonicalHash: "h1", Path: "docs/old.md"})
	if err != nil {
		t.Fatal(err)
	}
	if current {
		t.Fatal("stale delete after restore was considered current")
	}
	if err := updateQdrantWatermark(root, runtimequeue.QdrantIntent{EntityType: "doc", EntityID: "doc-1", Revision: 2, Path: "docs/new.md"}, "h2"); err != nil {
		t.Fatal(err)
	}
	readiness, err := QdrantEntityReadinessForStore(root)
	if err != nil || len(readiness) != 1 || readiness[0].Stale {
		t.Fatalf("stable watermark readiness = %#v, err=%v", readiness, err)
	}
	if readiness[0].EntityID != "doc-1" || readiness[0].Path != "docs/new.md" || readiness[0].IndexedPath != "docs/new.md" {
		t.Fatalf("watermark identity/path = %#v", readiness[0])
	}
}

func TestHardDeletePurgeReservationAuthorizesTargetedRemoval(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "history", "purged")
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
	writeJSONTest(t, filepath.Join(path, "task-purged.json"), map[string]any{
		"entityType": "task", "entityId": "purged", "path": "tasks/purged.md",
		"hash": "h1", "phase": "history_removed",
	})
	current, err := proveQdrantIntent(root, runtimequeue.QdrantIntent{EntityType: "task", EntityID: "purged", Operation: "hard_delete", CanonicalHash: "h1", Path: "tasks/purged.md"})
	if err != nil || !current {
		t.Fatalf("purge reservation proof = %v, err=%v", current, err)
	}
}

func TestTargetedDeleteProofRequiresTombstoneWithoutMutatingQdrant(t *testing.T) {
	root := t.TempDir()
	historyDir := filepath.Join(root, "history", "tasks")
	if err := os.MkdirAll(historyDir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeJSONLTest(t, filepath.Join(historyDir, "unsafe.jsonl"), map[string]any{
		"revision": 1, "operation": "delete", "newHash": "h1", "tombstone": false,
	})
	intent := runtimequeue.QdrantIntent{EntityType: "task", EntityID: "unsafe", Revision: 1, Operation: "delete", CanonicalHash: "h1", Path: "tasks/unsafe.md"}
	if ok, err := proveQdrantIntent(root, intent); err != nil || ok {
		t.Fatalf("non-tombstone delete proof = %v, %v; must fail before backend mutation", ok, err)
	}
}

func TestPublicIntentReadinessIsDurableAndDoesNotRegress(t *testing.T) {
	root := t.TempDir()
	older := runtimequeue.QdrantIntent{EntityType: "task", EntityID: "public", Revision: 1, Operation: "update", CanonicalHash: "h1", Path: "tasks/public.md", BatchID: "public-hook"}
	newer := older
	newer.Revision, newer.CanonicalHash = 2, "h2"
	if err := markQdrantIntentPending(root, older); err != nil {
		t.Fatal(err)
	}
	if err := markQdrantIntentPending(root, newer); err != nil {
		t.Fatal(err)
	}
	if err := updateQdrantWatermark(root, older, "h1"); err != nil {
		t.Fatal(err)
	}
	readiness, err := QdrantEntityReadinessForStore(root)
	if err != nil || len(readiness) != 1 {
		t.Fatalf("public readiness = %#v, err=%v", readiness, err)
	}
	got := readiness[0]
	if !got.Stale || got.CanonicalHash != "h2" || got.Revision != 2 || got.IndexedHash != "" {
		t.Fatalf("public readiness regressed after old completion: %#v", got)
	}
}

func TestPublicIntentIgnoresStaleManifestAndProvesCurrentHistory(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	if err := os.MkdirAll(filepath.Join(root, "tasks"), 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "tasks", "task-public - Public.md")
	writeTask := func(title string) {
		if err := os.WriteFile(path, []byte("---\nid: public\ntitle: "+title+"\nstatus: todo\npriority: medium\nlabels: []\n---\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	writeTask("Old")
	store := storage.NewStore(root)
	old, err := store.Tasks.Get("public")
	if err != nil {
		t.Fatal(err)
	}
	history := storage.NewHistoryStore(root)
	if err := history.Append(context.Background(), models.HistoryRecord{EntityType: "task", EntityID: "public", Operation: "update", NewHash: storage.CanonicalTaskHash(old), Checkpoint: true, CheckpointPayload: map[string]any{"id": "public", "title": "Old"}}); err != nil {
		t.Fatal(err)
	}
	writeTask("New")
	current, err := store.Tasks.Get("public")
	if err != nil {
		t.Fatal(err)
	}
	if err := history.Append(context.Background(), models.HistoryRecord{EntityType: "task", EntityID: "public", Operation: "update", BaseHash: storage.CanonicalTaskHash(old), NewHash: storage.CanonicalTaskHash(current), Checkpoint: true, CheckpointPayload: map[string]any{"id": "public", "title": "New"}}); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "history", "state"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeJSONTest(t, filepath.Join(root, "history", "state", "manifest.json"), map[string]any{"entries": map[string]any{"task:public": map[string]any{"entityType": "task", "entityId": "public", "path": "tasks/public.md", "hash": "old", "revision": 1}}})
	intent, err := currentPublicQdrantIntent(root, "task", "public", false)
	if err != nil || intent.Revision != 2 || intent.CanonicalHash != storage.CanonicalTaskHash(current) || intent.BatchID != "public-hook" {
		t.Fatalf("public intent = %#v, err=%v", intent, err)
	}
	if ok, err := proveQdrantIntent(root, intent); err != nil || !ok {
		t.Fatalf("current public proof = %v, %v", ok, err)
	}
}

func TestPublicTombstoneRemovalIgnoresStaleManifest(t *testing.T) {
	root := t.TempDir()
	history := storage.NewHistoryStore(root)
	if err := history.Append(context.Background(), models.HistoryRecord{EntityType: "task", EntityID: "gone", Operation: "delete", Tombstone: true, NewHash: "h2", Checkpoint: true, CheckpointPayload: map[string]any{"id": "gone"}}); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "history", "state"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeJSONTest(t, filepath.Join(root, "history", "state", "manifest.json"), map[string]any{"entries": map[string]any{"task:gone": map[string]any{"entityType": "task", "entityId": "gone", "path": "tasks/gone.md", "hash": "h1", "revision": 1}}})
	intent, err := currentPublicQdrantIntent(root, "task", "gone", true)
	if err != nil || intent.Operation != "delete" || intent.Revision != 1 || intent.BatchID != "public-hook" {
		t.Fatalf("public removal = %#v, %v", intent, err)
	}
	if ok, err := proveQdrantIntent(root, intent); err != nil || !ok {
		t.Fatalf("public tombstone proof = %v, %v", ok, err)
	}
}

func TestWatermarkEqualRevisionConflictFailsClosed(t *testing.T) {
	root := t.TempDir()
	first := runtimequeue.QdrantIntent{EntityType: "task", EntityID: "same", Revision: 1, Operation: "update", CanonicalHash: "h1", Path: "tasks/same.md"}
	if err := markQdrantIntentPending(root, first); err != nil {
		t.Fatal(err)
	}
	conflict := first
	conflict.CanonicalHash = "h2"
	if err := updateQdrantWatermark(root, conflict, "h2"); err == nil {
		t.Fatal("equal-revision conflicting completion was accepted")
	}
	values, err := LoadQdrantIndexWatermarks(root)
	if err != nil {
		t.Fatal(err)
	}
	if got := values["task:same"]; got.CanonicalHash != "h1" || !got.Stale {
		t.Fatalf("conflict overwrote pending watermark: %#v", got)
	}
}

func TestWatermarkConcurrentReadModifyWritePreservesAllEntries(t *testing.T) {
	root := t.TempDir()
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			intent := runtimequeue.QdrantIntent{EntityType: "task", EntityID: fmt.Sprintf("t-%d", i), Revision: 1, Operation: "update", CanonicalHash: fmt.Sprintf("h-%d", i), Path: fmt.Sprintf("tasks/t-%d.md", i)}
			if err := markQdrantIntentPending(root, intent); err != nil {
				t.Errorf("pending %d: %v", i, err)
			}
		}()
	}
	for i := 1; i <= 24; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			intent := runtimequeue.QdrantIntent{EntityType: "task", EntityID: "same", Revision: i, Operation: "update", CanonicalHash: fmt.Sprintf("same-%d", i), Path: "tasks/same.md"}
			if err := markQdrantIntentPending(root, intent); err != nil {
				t.Errorf("same %d: %v", i, err)
			}
		}()
	}
	wg.Wait()
	values, err := LoadQdrantIndexWatermarks(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(values) != 33 || values["task:same"].Revision != 24 {
		t.Fatalf("watermarks lost concurrent updates: len=%d same=%#v", len(values), values["task:same"])
	}
}

func TestPendingRemovalRemainsStaleUntilSuccessfulDelete(t *testing.T) {
	root := t.TempDir()
	intent := runtimequeue.QdrantIntent{EntityType: "task", EntityID: "gone", Revision: 2, Operation: "delete", CanonicalHash: "h2", Path: "tasks/gone.md"}
	if err := markQdrantIntentPending(root, intent); err != nil {
		t.Fatal(err)
	}
	readiness, err := QdrantEntityReadinessForStore(root)
	if err != nil || len(readiness) != 1 || !readiness[0].Stale {
		t.Fatalf("pending removal readiness = %#v, %v", readiness, err)
	}
	if err := updateQdrantWatermark(root, intent, ""); err != nil {
		t.Fatal(err)
	}
	readiness, err = QdrantEntityReadinessForStore(root)
	if err != nil || len(readiness) != 0 {
		t.Fatalf("completed removal readiness = %#v, %v", readiness, err)
	}
}

func TestBestEffortRenameDocQueuesSingleStableIntent(t *testing.T) {
	store := configureSemanticStore(t, &models.SemanticVectorStoreSettings{Backend: models.SemanticVectorBackendQdrant})
	if err := os.MkdirAll(filepath.Join(store.Root, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.Root, "docs", "new.md"), []byte("---\nid: doc-rename\ntitle: New\n---\nbody\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	doc, err := store.Docs.Get("new")
	if err != nil {
		t.Fatal(err)
	}
	if err := storage.NewHistoryStore(store.Root).Append(context.Background(), models.HistoryRecord{EntityType: "doc", EntityID: doc.ID, Operation: "rename", NewHash: storage.CanonicalDocHash(doc), Checkpoint: true, CheckpointPayload: storage.DocToSnapshot(doc), CurrentPath: "docs/new.md", PreviousPath: "docs/old.md"}); err != nil {
		t.Fatal(err)
	}
	BestEffortRenameDoc(store, doc.ID, "old", "new")
	queue, err := runtimequeue.LoadQueue(store.Root)
	if err != nil {
		t.Fatal(err)
	}
	if len(queue.Jobs) != 1 || queue.Jobs[0].Intent == nil {
		t.Fatalf("rename queue = %#v", queue.Jobs)
	}
	intent := queue.Jobs[0].Intent
	if intent.EntityID != doc.ID || intent.Operation != "rename" || intent.Path != "docs/new.md" || intent.PreviousPath != "docs/old.md" {
		t.Fatalf("rename intent = %#v", intent)
	}
}

func TestPublicMismatchDoesNotPersistWatermarkOrQueue(t *testing.T) {
	store := configureSemanticStore(t, &models.SemanticVectorStoreSettings{Backend: models.SemanticVectorBackendQdrant})
	if err := os.MkdirAll(filepath.Join(store.Root, "tasks"), 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(store.Root, "tasks", "task-mismatch - Mismatch.md")
	if err := os.WriteFile(path, []byte("---\nid: mismatch\ntitle: Old\nstatus: todo\npriority: medium\nlabels: []\n---\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	task, err := store.Tasks.Get("mismatch")
	if err != nil {
		t.Fatal(err)
	}
	if err := storage.NewHistoryStore(store.Root).Append(context.Background(), models.HistoryRecord{EntityType: "task", EntityID: "mismatch", Operation: "update", NewHash: storage.CanonicalTaskHash(task), Checkpoint: true, CheckpointPayload: map[string]any{"id": "mismatch", "title": "Old"}}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("---\nid: mismatch\ntitle: New\nstatus: todo\npriority: medium\nlabels: []\n---\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	qdrantBestEffortIntent(store, "task", "mismatch", false)
	queue, err := runtimequeue.LoadQueue(store.Root)
	if err != nil {
		t.Fatal(err)
	}
	watermarks, err := LoadQdrantIndexWatermarks(store.Root)
	if err != nil {
		t.Fatal(err)
	}
	if len(queue.Jobs) != 0 || len(watermarks) != 0 {
		t.Fatalf("unproven public intent persisted queue=%#v watermarks=%#v", queue.Jobs, watermarks)
	}
}

func TestDeleteWatermarkEqualRevisionConflictPreservesPendingState(t *testing.T) {
	root := t.TempDir()
	pending := runtimequeue.QdrantIntent{EntityType: "task", EntityID: "gone", Revision: 2, Operation: "delete", CanonicalHash: "h2", Path: "tasks/gone.md"}
	if err := markQdrantIntentPending(root, pending); err != nil {
		t.Fatal(err)
	}
	conflict := pending
	conflict.CanonicalHash, conflict.Path = "other", "tasks/other.md"
	if err := updateQdrantWatermark(root, conflict, ""); err == nil {
		t.Fatal("conflicting delete completion was accepted")
	}
	values, err := LoadQdrantIndexWatermarks(root)
	if err != nil {
		t.Fatal(err)
	}
	if got := values["task:gone"]; got.Removed || !got.PendingRemoval || got.CanonicalHash != "h2" {
		t.Fatalf("conflicting delete changed watermark: %#v", got)
	}
}

func TestRemovedWatermarkSuppressesStaleManifestButNewerRestoreIsStale(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "history", "state"), 0o755); err != nil {
		t.Fatal(err)
	}
	intent := runtimequeue.QdrantIntent{EntityType: "task", EntityID: "gone", Revision: 2, Operation: "delete", CanonicalHash: "h2", Path: "tasks/gone.md"}
	if err := markQdrantIntentPending(root, intent); err != nil {
		t.Fatal(err)
	}
	if err := updateQdrantWatermark(root, intent, ""); err != nil {
		t.Fatal(err)
	}
	writeJSONTest(t, filepath.Join(root, "history", "state", "manifest.json"), map[string]any{"entries": map[string]any{"task:gone": map[string]any{"entityType": "task", "entityId": "gone", "path": "tasks/gone.md", "hash": "h1", "revision": 1}}})
	readiness, err := QdrantEntityReadinessForStore(root)
	if err != nil || len(readiness) != 0 {
		t.Fatalf("stale manifest survived delete: %#v %v", readiness, err)
	}
	writeJSONTest(t, filepath.Join(root, "history", "state", "manifest.json"), map[string]any{"entries": map[string]any{"task:gone": map[string]any{"entityType": "task", "entityId": "gone", "path": "tasks/gone.md", "hash": "h3", "revision": 3}}})
	readiness, err = QdrantEntityReadinessForStore(root)
	if err != nil || len(readiness) != 1 || !readiness[0].Stale || readiness[0].Revision != 3 {
		t.Fatalf("newer restore readiness = %#v %v", readiness, err)
	}
}

func TestDurableDocTombstoneQueuesStableRemovalIntent(t *testing.T) {
	store := configureSemanticStore(t, &models.SemanticVectorStoreSettings{Backend: models.SemanticVectorBackendQdrant})
	doc := &models.Doc{Path: "delete-queue", Title: "Delete", Content: "body"}
	if err := store.MutateDocWithHistory(context.Background(), nil, doc, storage.DocMutationOptions{Actor: "test", Source: "test"}); err != nil {
		t.Fatal(err)
	}
	current, err := store.Docs.Get(doc.Path)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteDocWithExpectedHash(context.Background(), doc.Path, storage.DocDeleteOptions{ExpectedHash: current.CanonicalHash, Actor: "test", Source: "test"}); err != nil {
		t.Fatal(err)
	}
	stream, err := storage.NewHistoryStore(store.Root).Read(context.Background(), "doc", current.ID)
	if err != nil || len(stream.Records) != 2 || !stream.Records[1].Tombstone {
		t.Fatalf("tombstone history = %#v, %v", stream, err)
	}
	BestEffortRemoveDocID(store, current.ID, current.Path)
	queue, err := runtimequeue.LoadQueue(store.Root)
	if err != nil {
		t.Fatal(err)
	}
	if len(queue.Jobs) != 1 || queue.Jobs[0].Intent == nil || queue.Jobs[0].Intent.EntityID != current.ID || queue.Jobs[0].Intent.Operation != "delete" {
		t.Fatalf("removal queue = %#v", queue.Jobs)
	}
}

func TestTargetedSourceLifecycleDeletesOldSourcesAndUsesSemanticHash(t *testing.T) {
	client := &targetedFakeClient{info: QdrantCollectionInfo{Exists: true, Dimensions: 384, Distance: "cosine", Status: "green"}}
	chunks := []Chunk{{ID: "doc:new:0", Type: ChunkTypeDoc, DocPath: "new", Content: "new canonical text", Position: 0, Embedding: []float32{0.1, 0.2}}}
	semanticHash := contentHash("title\ndescription\nnew canonical text")
	if err := reconcileQdrantSource(context.Background(), client, "kn_target", "doc:old", "doc:new", chunks, semanticHash); err != nil {
		t.Fatal(err)
	}
	if len(client.deletes) != 2 || client.deletes[0] != "doc:old" || client.deletes[1] != "doc:new" {
		t.Fatalf("source deletes = %#v, want old and current exact sources", client.deletes)
	}
	if len(client.upserts) != 1 || len(client.upserts[0]) != 1 {
		t.Fatalf("upserts = %#v, want one affected chunk", client.upserts)
	}
	if got := client.upserts[0][0].Payload[qdrantPayloadContentHash]; got != semanticHash {
		t.Fatalf("semantic payload hash = %#v, want %s", got, semanticHash)
	}
	if strings.Contains(string(mustJSON(t, client.upserts[0][0].Payload)), "new canonical text") {
		t.Fatal("Qdrant payload leaked canonical content")
	}
}

func TestTargetedOutageLeavesWatermarkUntilRetrySucceeds(t *testing.T) {
	root := t.TempDir()
	client := &targetedFakeClient{failUpsert: true}
	chunks := []Chunk{{ID: "task:t:0", Type: ChunkTypeTask, TaskID: "t", Content: "canonical", Embedding: []float32{0.1}}}
	if err := reconcileQdrantSource(context.Background(), client, "kn", "", "task:t", chunks, "semantic-hash"); err == nil {
		t.Fatal("outage unexpectedly succeeded")
	}
	watermarks, err := LoadQdrantIndexWatermarks(root)
	if err != nil || len(watermarks) != 0 {
		t.Fatalf("watermark advanced during outage: %#v, err=%v", watermarks, err)
	}
	client.failUpsert = false
	if err := reconcileQdrantSource(context.Background(), client, "kn", "", "task:t", chunks, "semantic-hash"); err != nil {
		t.Fatal(err)
	}
	if err := updateQdrantWatermark(root, runtimequeue.QdrantIntent{EntityType: "task", EntityID: "t", Revision: 1, Path: "tasks/t.md"}, "canonical-hash"); err != nil {
		t.Fatal(err)
	}
	watermarks, err = LoadQdrantIndexWatermarks(root)
	if err != nil || watermarks["task:t"].IndexedHash != "canonical-hash" {
		t.Fatalf("watermark after retry = %#v, err=%v", watermarks, err)
	}
}

func TestTargetedWatermarksAreProjectIsolated(t *testing.T) {
	rootA, rootB := filepath.Join(t.TempDir(), ".knowns"), filepath.Join(t.TempDir(), ".knowns")
	for _, root := range []string{rootA, rootB} {
		if err := updateQdrantWatermark(root, runtimequeue.QdrantIntent{EntityType: "task", EntityID: "same", Revision: 1, Path: "tasks/same.md"}, root); err != nil {
			t.Fatal(err)
		}
	}
	a, err := LoadQdrantIndexWatermarks(rootA)
	if err != nil || a["task:same"].IndexedHash != rootA {
		t.Fatalf("project A watermark = %#v, err=%v", a, err)
	}
	b, err := LoadQdrantIndexWatermarks(rootB)
	if err != nil || b["task:same"].IndexedHash != rootB {
		t.Fatalf("project B watermark = %#v, err=%v", b, err)
	}
}

func TestTargetedIntentAndStatusAreContentFree(t *testing.T) {
	intent, err := json.Marshal(runtimequeue.QdrantIntent{EntityType: "task", EntityID: "safe", Revision: 4, Operation: "update", CanonicalHash: "abc", Path: "tasks/safe.md"})
	if err != nil {
		t.Fatal(err)
	}
	raw := string(intent)
	for _, forbidden := range []string{"secret body", "apiKey", "https://qdrant"} {
		if strings.Contains(raw, forbidden) {
			t.Fatalf("intent leaked %q: %s", forbidden, raw)
		}
	}
}

func writeJSONTest(t *testing.T, path string, value any) {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func writeJSONLTest(t *testing.T, path string, value any) {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(data, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
}

var _ QdrantClient = (*targetedFakeClient)(nil)
var _ qdrantSourceDeleter = (*targetedFakeClient)(nil)
