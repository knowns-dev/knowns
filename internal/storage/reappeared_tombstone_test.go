package storage

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

// These tests cover a file that disappears for a few seconds and returns
// byte-identical, as `git stash -u`, a checkout, or a pull does. Observed on
// 2026-09-10: the watcher tombstoned three Docs, the files came back, and the
// Docs became permanently unwritable.

func reappearedHead(t *testing.T, r *FilesystemReconciler, kind, id string) models.HistoryRecord {
	t.Helper()
	stream, err := r.history.Read(context.Background(), kind, id)
	if err != nil || len(stream.Records) == 0 {
		t.Fatalf("read %s %s history: records=%d err=%v", kind, id, len(stream.Records), err)
	}
	return stream.Records[len(stream.Records)-1]
}

func reappearedDoc(t *testing.T, store *Store) *models.Doc {
	t.Helper()
	doc, err := store.Docs.Get("guides/returned")
	if err != nil {
		t.Fatal(err)
	}
	return doc
}

// newReappearedDocStore leaves a section-scoped revision at the head of a Doc.
// That revision's display snapshot omits content, which is the shape that
// produced content-less tombstones in the field.
func newReappearedDocStore(t *testing.T) (*Store, *models.Doc) {
	t.Helper()
	ctx := context.Background()
	store := NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("reappeared-doc"); err != nil {
		t.Fatal(err)
	}
	created := &models.Doc{Path: "guides/returned", Title: "Returned", Content: "## One\nfirst one\n\n## Two\nfirst two"}
	if err := store.MutateDocWithHistory(ctx, nil, created, DocMutationOptions{Actor: "test", Source: "test"}); err != nil {
		t.Fatal(err)
	}
	current := reappearedDoc(t, store)
	edited := *current
	edited.Content = "## One\nsecond one\n\n## Two\nfirst two"
	if err := store.MutateDocWithHistory(ctx, current, &edited, DocMutationOptions{Actor: "test", Source: "test", Section: "One"}); err != nil {
		t.Fatal(err)
	}
	return store, reappearedDoc(t, store)
}

// TestReconciliationNeverTombstonesAFileItCouldNotRead covers the field
// failure of 2026-09-25: a runtime out of file descriptors failed to read task
// files during inventory, then read them again moments later, and appended a
// delete tombstone for every one of them while the files never moved.
func TestReconciliationNeverTombstonesAFileItCouldNotRead(t *testing.T) {
	ctx := context.Background()
	root := filepath.Join(t.TempDir(), ".knowns")
	path := lifecycleTaskFile(t, root, "alive", "unread", "Alive")
	r, err := NewFilesystemReconciler(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.ReconcileLifecycle(ctx, true); err != nil {
		t.Fatal(err)
	}
	live := reappearedHead(t, r, "task", "unread")

	// Fail only the inventory read; every later read succeeds, as happens when
	// descriptors free up mid-pass.
	failed := false
	r.SetLifecycleFailureHooks(LifecycleFailureHooks{BeforeCanonicalRead: func(p string) error {
		if !failed && filepath.Clean(p) == filepath.Clean(path) {
			failed = true
			return errors.New("too many open files")
		}
		return nil
	}})
	results, err := r.ReconcileLifecycle(ctx, true)
	if err != nil {
		t.Fatal(err)
	}
	if !failed {
		t.Fatal("the inventory read was never attempted")
	}
	for _, res := range results {
		if res.EntityID == "unread" && res.Changed {
			t.Fatalf("an unreadable file changed its entity: %+v", res)
		}
	}
	if head := reappearedHead(t, r, "task", "unread"); head.Tombstone || head.Revision != live.Revision {
		t.Fatalf("history head = %+v, want the untouched live head at revision %d", head, live.Revision)
	}

	r.SetLifecycleFailureHooks(LifecycleFailureHooks{})
	again, err := r.ReconcileLifecycle(ctx, true)
	if err != nil {
		t.Fatal(err)
	}
	for _, res := range again {
		if res.EntityID == "unread" && (res.Changed || res.Diagnostic != "") {
			t.Fatalf("a readable pass did not settle the entity: %+v", res)
		}
	}
}

func TestReconciliationReactivatesATaskWhoseFileReturnedUnchanged(t *testing.T) {
	ctx := context.Background()
	root := filepath.Join(t.TempDir(), ".knowns")
	lifecycleTaskFile(t, root, "alive", "returned", "Alive")
	r, err := NewFilesystemReconciler(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.ReconcileLifecycle(ctx, true); err != nil {
		t.Fatal(err)
	}
	live := reappearedHead(t, r, "task", "returned")
	if err := r.appendHistoryRecord(ctx, models.HistoryRecord{
		EntityType: "task", EntityID: "returned", Source: "watcher", Operation: LifecycleOperationDelete,
		Tombstone: true, Timestamp: time.Now().UTC(), BaseHash: live.NewHash, NewHash: live.NewHash,
		Checkpoint: true, CheckpointPayload: live.CheckpointPayload, CurrentPath: "tasks/alive.md",
	}); err != nil {
		t.Fatal(err)
	}

	results, err := r.ReconcileLifecycle(ctx, true)
	if err != nil {
		t.Fatal(err)
	}
	// A same-path entity is visited twice in one pass, once through its
	// manifest entry and once as a remaining file; only the first records the
	// restore, and the second sees an already-settled head.
	restored := false
	for _, res := range results {
		if res.EntityID == "returned" && res.Operation == LifecycleOperationRestore && res.Changed && res.Diagnostic == "" {
			restored = true
		}
	}
	if !restored {
		t.Fatalf("reconciliation did not restore the returned Task: %+v", results)
	}
	head := reappearedHead(t, r, "task", "returned")
	if head.Operation != LifecycleOperationRestore || head.Tombstone || head.NewHash != live.NewHash {
		t.Fatalf("history head = %+v, want a restore at the unchanged hash", head)
	}

	again, err := r.ReconcileLifecycle(ctx, true)
	if err != nil {
		t.Fatal(err)
	}
	for _, res := range again {
		if res.EntityID == "returned" && res.Changed {
			t.Fatalf("second pass changed the entity again: %+v", res)
		}
	}
}

func TestDocTombstonedAfterASectionEditReturnsAndStaysWritable(t *testing.T) {
	ctx := context.Background()
	store, doc := newReappearedDocStore(t)
	r, err := NewFilesystemReconciler(store.Root)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	r.SetLifecycleClock(func() time.Time { return now })
	if _, err := r.ReconcileLifecycle(ctx, true); err != nil {
		t.Fatal(err)
	}
	if head := reappearedHead(t, r, "doc", doc.ID); firstSectionScopeFromRecord(head) == "" {
		t.Fatalf("head is not section-scoped, so this test would not reproduce the field shape: %+v", head)
	}

	path := filepath.Join(store.Root, "docs", "guides", "returned.md")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, err := r.ReconcileLifecycle(ctx, true); err != nil {
		t.Fatal(err)
	}
	now = now.Add(ReconcileQuietWindow)
	if _, err := r.ReconcileLifecycle(ctx, true); err != nil {
		t.Fatal(err)
	}
	tomb := reappearedHead(t, r, "doc", doc.ID)
	if !tomb.Tombstone || tomb.Operation != LifecycleOperationDelete {
		t.Fatalf("head = %+v, want a delete tombstone", tomb)
	}
	if _, ok := tomb.CheckpointPayload["content"]; !ok {
		t.Fatalf("tombstone checkpoint lost the document content: %#v", tomb.CheckpointPayload)
	}

	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	results, err := r.ReconcileLifecycle(ctx, true)
	if err != nil {
		t.Fatal(err)
	}
	restored := false
	for _, res := range results {
		if res.EntityID == doc.ID && res.Operation == LifecycleOperationRestore && res.Changed && res.Diagnostic == "" {
			restored = true
		}
	}
	if !restored {
		t.Fatalf("reconciliation did not restore the returned Doc: %+v", results)
	}
	head := reappearedHead(t, r, "doc", doc.ID)
	if head.Tombstone || head.Operation != LifecycleOperationRestore {
		t.Fatalf("history head still claims deletion: %+v", head)
	}
	stream, err := r.history.Read(ctx, "doc", doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := docHistoryFromRecords("guides/returned", stream.Records); err != nil {
		t.Fatalf("replay after reactivation: %v", err)
	}

	current := reappearedDoc(t, store)
	edited := *current
	edited.Content = "## One\nsecond one\n\n## Two\nsecond two"
	if err := store.MutateDocWithHistory(ctx, current, &edited, DocMutationOptions{Actor: "test", Source: "test", Section: "Two"}); err != nil {
		t.Fatalf("section write after reactivation: %v", err)
	}
	if got := reappearedDoc(t, store); got.Content != edited.Content {
		t.Fatalf("content after write = %q, want %q", got.Content, edited.Content)
	}
}

func TestReconciliationLeavesAnUnfinishedDocDeleteForRecovery(t *testing.T) {
	ctx := context.Background()
	store, doc := newReappearedDocStore(t)
	r, err := NewFilesystemReconciler(store.Root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.ReconcileLifecycle(ctx, true); err != nil {
		t.Fatal(err)
	}
	live := reappearedHead(t, r, "doc", doc.ID)
	// A user delete that stopped after its tombstone and before removing the
	// file leaves exactly this state plus a transaction marker.
	if err := r.appendHistoryRecord(ctx, models.HistoryRecord{
		EntityType: "doc", EntityID: doc.ID, Source: "cli", Operation: LifecycleOperationDelete,
		Tombstone: true, Timestamp: time.Now().UTC(), BaseHash: live.NewHash, NewHash: live.NewHash,
		Checkpoint: true, CheckpointPayload: rawDocSnapshot(doc), CurrentPath: "guides/returned",
	}); err != nil {
		t.Fatal(err)
	}
	if err := writeDocDeleteTransaction(store.Root, docDeleteTransaction{
		SchemaVersion: 1, EntityID: doc.ID, Path: "docs/guides/returned.md", Hash: live.NewHash, Source: "cli", Timestamp: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.ReconcileLifecycle(ctx, true); err != nil {
		t.Fatal(err)
	}
	if head := reappearedHead(t, r, "doc", doc.ID); !head.Tombstone || head.Operation != LifecycleOperationDelete {
		t.Fatalf("reconciliation undid a delete the user asked for: %+v", head)
	}
}

func TestReplayHealsLifecycleCheckpointsThatLostTheirContent(t *testing.T) {
	ctx := context.Background()
	store, doc := newReappearedDocStore(t)
	r, err := NewFilesystemReconciler(store.Root)
	if err != nil {
		t.Fatal(err)
	}
	live := reappearedHead(t, r, "doc", doc.ID)
	lost := rawDocSnapshot(doc)
	delete(lost, "content")
	alone := &models.Doc{}
	applyDocSnapshot(alone, lost)
	if docHashRecognized(live.NewHash, alone) {
		t.Fatal("content-less payload describes the recorded hash on its own; the test would not exercise healing")
	}
	// The exact pair written in the field: a tombstone and then a restore, both
	// taken from a display snapshot without content.
	for _, rec := range []models.HistoryRecord{
		{EntityType: "doc", EntityID: doc.ID, Source: "watcher", Operation: LifecycleOperationDelete, Tombstone: true, Timestamp: time.Now().UTC(), BaseHash: live.NewHash, NewHash: live.NewHash, Checkpoint: true, CheckpointPayload: lost, CurrentPath: "guides/returned"},
		{EntityType: "doc", EntityID: doc.ID, Source: "restore", Operation: LifecycleOperationRestore, Timestamp: time.Now().UTC(), BaseHash: live.NewHash, NewHash: live.NewHash, Checkpoint: true, CheckpointPayload: cloneMap(lost), CurrentPath: "guides/returned"},
	} {
		if err := r.appendHistoryRecord(ctx, rec); err != nil {
			t.Fatal(err)
		}
	}

	historyPath := filepath.Join(store.Root, "history", "docs", doc.ID+".jsonl")
	before, err := os.ReadFile(historyPath)
	if err != nil {
		t.Fatal(err)
	}
	stream, err := r.history.Read(ctx, "doc", doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := docHistoryFromRecords("guides/returned", stream.Records); err != nil {
		t.Fatalf("replay of content-less lifecycle checkpoints: %v", err)
	}
	if _, err := store.Versions.GetDocHistory("guides/returned"); err != nil {
		t.Fatalf("doc history of content-less lifecycle checkpoints: %v", err)
	}
	after, err := os.ReadFile(historyPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("reading history rewrote the history file")
	}

	current := reappearedDoc(t, store)
	edited := *current
	edited.Content = "## One\nsecond one\n\n## Two\nhealed two"
	if err := store.MutateDocWithHistory(ctx, current, &edited, DocMutationOptions{Actor: "test", Source: "test", Section: "Two"}); err != nil {
		t.Fatalf("section write over healed history: %v", err)
	}
	grown, err := os.ReadFile(historyPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(grown, before) || len(grown) == len(before) {
		t.Fatal("the write did not append to the existing history unchanged")
	}
}
