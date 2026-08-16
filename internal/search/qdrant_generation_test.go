package search

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

type fakeGenerationClient struct {
	info         QdrantCollectionInfo
	count        int64
	failUpsert   bool
	failDeleteAt int
	deleted      []string
}

func (f *fakeGenerationClient) CreateCollection(context.Context, string, int) error {
	f.info = QdrantCollectionInfo{Exists: true, Dimensions: 1, Distance: QdrantRESTDistanceCosine}
	return nil
}
func (f *fakeGenerationClient) CollectionExists(context.Context, string) (bool, error) {
	return f.info.Exists, nil
}
func (f *fakeGenerationClient) InspectCollection(context.Context, string) (QdrantCollectionInfo, error) {
	return f.info, nil
}
func (f *fakeGenerationClient) CountPoints(context.Context, string) (int64, error) {
	return f.count, nil
}
func (f *fakeGenerationClient) UpsertPoints(_ context.Context, _ string, p []QdrantPoint) error {
	if f.failUpsert {
		return errors.New("upsert failed")
	}
	f.count = int64(len(p))
	return nil
}
func (f *fakeGenerationClient) Query(context.Context, string, []float32, QdrantQueryOptions) ([]ScoredChunk, error) {
	return nil, nil
}
func (f *fakeGenerationClient) QueryValidated(context.Context, string, []float32, QdrantQueryOptions, QdrantHitValidationContext) ([]ScoredChunk, QdrantHitValidationSummary, error) {
	return nil, QdrantHitValidationSummary{}, nil
}
func (f *fakeGenerationClient) DeletePoints(context.Context, string, []string) error { return nil }
func (f *fakeGenerationClient) DeleteCollection(_ context.Context, n string) error {
	if f.failDeleteAt > 0 && len(f.deleted)+1 == f.failDeleteAt {
		return errors.New("delete failed")
	}
	f.deleted = append(f.deleted, n)
	return nil
}

func TestQdrantGenerationFileLockTimeoutAndStaleRecovery(t *testing.T) {
	root := t.TempDir()
	release, err := acquireQdrantGenerationFileLock(context.Background(), root, time.Second, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	if _, err := acquireQdrantGenerationFileLock(context.Background(), root, 80*time.Millisecond, time.Hour); err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("concurrent lock err=%v", err)
	}
	if time.Since(started) < 70*time.Millisecond {
		t.Fatal("lock did not wait")
	}
	release()
	if err := os.MkdirAll(filepath.Dir(qdrantGenerationLockPath(root)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(qdrantGenerationLockPath(root), []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(qdrantGenerationLockPath(root), old, old); err != nil {
		t.Fatal(err)
	}
	recovered, err := acquireQdrantGenerationFileLock(context.Background(), root, time.Second, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	recovered()
}

func TestGenerationHistoryAtomicFailureAndNumbering(t *testing.T) {
	store := configureSemanticStore(t, &models.SemanticVectorStoreSettings{Backend: models.SemanticVectorBackendQdrant})
	client := &fakeGenerationClient{}
	first, err := ReindexQdrantGeneration(context.Background(), store, stubEmbedder{}, QdrantGenerationOptions{Client: client, RetentionGenerations: 1})
	if err != nil {
		t.Fatal(err)
	}
	records, err := LoadQdrantGenerations(store.Root)
	if err != nil || len(records) != 1 || records[0].Generation != 1 || records[0].Status != QdrantGenerationStatusActive {
		t.Fatalf("first records=%#v err=%v", records, err)
	}
	second, err := ReindexQdrantGeneration(context.Background(), store, stubEmbedder{}, QdrantGenerationOptions{Client: client, RetentionGenerations: 1})
	if err != nil {
		t.Fatal(err)
	}
	records, err = LoadQdrantGenerations(store.Root)
	if err != nil || len(records) != 2 || records[0].Generation != 1 || records[0].Status != QdrantGenerationStatusInactive || records[1].Generation != 2 || records[1].Status != QdrantGenerationStatusActive {
		t.Fatalf("second records=%#v err=%v", records, err)
	}
	before, _ := os.ReadFile(QdrantGenerationsPath(store.Root))
	failed, err := ReindexQdrantGeneration(context.Background(), store, stubEmbedder{}, QdrantGenerationOptions{Client: client, RetentionGenerations: 1, HistoryWriter: func(string, []QdrantGenerationRecord) error { return errors.New("disk full") }})
	if err == nil || failed.HistoryError == nil {
		t.Fatalf("history failure result=%#v err=%v", failed, err)
	}
	after, _ := os.ReadFile(QdrantGenerationsPath(store.Root))
	if string(before) != string(after) {
		t.Fatal("failed atomic history write changed snapshot")
	}
	pointer, _ := LoadQdrantPointer(store.Root)
	if pointer.CollectionUUID != failed.Pointer.CollectionUUID {
		t.Fatal("activated pointer was not reported after history failure")
	}
	_ = first
	_ = second
}

func TestPurgeReturnsPartialDeletesOnLaterFailure(t *testing.T) {
	root := t.TempDir()
	owner := QdrantOwnerPointer{StoreRootFingerprint: StoreRootFingerprint(root)}
	pointer := &QdrantPointer{CollectionUUID: "b", CollectionName: "b", Owner: owner}
	if err := SaveQdrantPointer(root, pointer); err != nil {
		t.Fatal(err)
	}
	if err := SaveQdrantGenerations(root, []QdrantGenerationRecord{{Generation: 1, CollectionUUID: "a", CollectionName: "a", Status: QdrantGenerationStatusInactive, Owner: owner}}); err != nil {
		t.Fatal(err)
	}
	client := &fakeGenerationClient{failDeleteAt: 2}
	deleted, err := PurgeQdrantCollections(context.Background(), root, client)
	if err == nil || len(deleted) != 1 || deleted[0] != "a" {
		t.Fatalf("deleted=%v err=%v", deleted, err)
	}
}

func TestReindexQdrantGenerationActivatesOnlyAfterValidationAndDoesNotReadSQLiteRows(t *testing.T) {
	store := configureSemanticStore(t, &models.SemanticVectorStoreSettings{Backend: models.SemanticVectorBackendQdrant})
	legacy := QdrantLegacySQLitePath(store.Root)
	if err := os.MkdirAll(filepath.Dir(legacy), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(legacy, []byte("not a sqlite database and must never be opened"), 0o644); err != nil {
		t.Fatal(err)
	}
	client := &fakeGenerationClient{}
	result, err := ReindexQdrantGeneration(context.Background(), store, stubEmbedder{}, QdrantGenerationOptions{Client: client, RetentionGenerations: 1, RetentionTTL: 72 * time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	if result.Pointer == nil || result.Pointer.ChunkCount != 0 {
		t.Fatalf("result=%#v", result)
	}
	pointer, err := LoadQdrantPointer(store.Root)
	if err != nil || pointer.CollectionUUID != result.Pointer.CollectionUUID {
		t.Fatalf("pointer=%#v err=%v", pointer, err)
	}
}

func TestReindexQdrantGenerationFailurePreservesOldPointer(t *testing.T) {
	store := configureSemanticStore(t, &models.SemanticVectorStoreSettings{Backend: models.SemanticVectorBackendQdrant})
	old, _ := NewQdrantPointer(store.Root, "project", QdrantEmbeddingPointer{Model: "old", Dimensions: 1})
	if err := SaveQdrantPointer(store.Root, old); err != nil {
		t.Fatal(err)
	}
	client := &fakeGenerationClient{failUpsert: true}
	if _, err := ReindexQdrantGeneration(context.Background(), store, stubEmbedder{}, QdrantGenerationOptions{Client: client}); err == nil {
		t.Fatal("expected failure")
	}
	got, _ := LoadQdrantPointer(store.Root)
	if got.CollectionUUID != old.CollectionUUID {
		t.Fatalf("old pointer replaced: %#v", got)
	}
	if len(client.deleted) != 1 {
		t.Fatalf("failed generation cleanup=%v", client.deleted)
	}
}

func TestCleanupAndPurgeRequireOwnerProofAndApplyHardCap(t *testing.T) {
	root := t.TempDir()
	owner := QdrantOwnerPointer{StoreRootFingerprint: StoreRootFingerprint(root)}
	active := &QdrantPointer{CollectionUUID: "a", CollectionName: "active", Owner: owner}
	now := time.Now().UTC()
	for i, name := range []string{"recent", "older"} {
		retired := now.Add(-time.Hour)
		if err := AppendQdrantGeneration(root, QdrantGenerationRecord{Generation: i + 1, CollectionName: name, CollectionUUID: name, Status: QdrantGenerationStatusInactive, Owner: owner, RetiredAt: &retired}); err != nil {
			t.Fatal(err)
		}
	}
	client := &fakeGenerationClient{}
	deleted, errs := CleanupQdrantGenerations(context.Background(), root, client, active, 1, 72*time.Hour, now)
	if len(errs) != 0 || len(deleted) != 1 || deleted[0] != "recent" {
		t.Fatalf("deleted=%v errs=%v", deleted, errs)
	}
	bad := *active
	bad.Owner.StoreRootFingerprint = ""
	if _, errs := CleanupQdrantGenerations(context.Background(), root, client, &bad, 1, time.Hour, now); len(errs) == 0 {
		t.Fatal("cleanup without proof succeeded")
	}
	expiredRoot := t.TempDir()
	expiredOwner := QdrantOwnerPointer{StoreRootFingerprint: StoreRootFingerprint(expiredRoot)}
	expiredActive := &QdrantPointer{CollectionUUID: "active", CollectionName: "active", Owner: expiredOwner}
	retired := now.Add(-73 * time.Hour)
	if err := AppendQdrantGeneration(expiredRoot, QdrantGenerationRecord{Generation: 1, CollectionUUID: "expired", CollectionName: "expired", Status: QdrantGenerationStatusInactive, Owner: expiredOwner, RetiredAt: &retired}); err != nil {
		t.Fatal(err)
	}
	if deleted, errs := CleanupQdrantGenerations(context.Background(), expiredRoot, client, expiredActive, 1, 72*time.Hour, now); len(errs) != 0 || len(deleted) != 1 || deleted[0] != "expired" {
		t.Fatalf("TTL cleanup deleted=%v errs=%v", deleted, errs)
	}
	if _, err := PurgeQdrantCollections(context.Background(), t.TempDir(), client); err == nil {
		t.Fatal("purge without pointer/ownership proof succeeded")
	}
}
