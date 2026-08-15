package storage

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

func injectedHistoryStore(root string) *HistoryStore {
	return NewHistoryStore(root, HistoryStoreOptions{
		Append: func(*os.File, []byte) (int, error) { return 0, errors.New("injected history append") },
	})
}

func TestCreateTaskWithHistoryRollsBackCanonicalTaskOnHistoryFailure(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("task-atomic-create"); err != nil {
		t.Fatal(err)
	}
	store.Versions.history = injectedHistoryStore(store.Root)
	task := &models.Task{ID: "atomic-task", Title: "Atomic", Status: "todo", Priority: "medium"}
	err := store.CreateTaskWithHistory(context.Background(), task, models.TaskVersion{Snapshot: TaskToSnapshot(task)})
	if err == nil || !errors.Is(err, ErrHistoryCorrupt) && !strings.Contains(err.Error(), "injected history append") {
		t.Fatalf("create error=%v, want append failure", err)
	}
	if _, getErr := store.Tasks.Get(task.ID); getErr == nil {
		t.Fatal("Task remained after failed history append")
	}
}

func TestMutateDocWithHistoryRollsBackCreateAndUpdate(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("doc-atomic-rollback"); err != nil {
		t.Fatal(err)
	}
	store.Versions.history = injectedHistoryStore(store.Root)
	created := &models.Doc{Path: "guides/atomic", Title: "Atomic", Content: "old"}
	if err := store.MutateDocWithHistory(context.Background(), nil, created, DocMutationOptions{}); err == nil {
		t.Fatal("create unexpectedly succeeded with injected history failure")
	}
	if _, err := store.Docs.Get(created.Path); err == nil {
		t.Fatal("Doc remained after failed history append")
	}

	store = NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("doc-atomic-update"); err != nil {
		t.Fatal(err)
	}
	old := &models.Doc{Path: "guides/atomic", Title: "Atomic", Content: "old"}
	if err := store.MutateDocWithHistory(context.Background(), nil, old, DocMutationOptions{}); err != nil {
		t.Fatal(err)
	}
	store.Versions.history = injectedHistoryStore(store.Root)
	candidate := *old
	candidate.Content = "new"
	if err := store.MutateDocWithHistory(context.Background(), old, &candidate, DocMutationOptions{}); err == nil {
		t.Fatal("update unexpectedly succeeded with injected history failure")
	}
	got, err := store.Docs.Get(old.Path)
	if err != nil {
		t.Fatal(err)
	}
	if hashDoc(got) != hashDoc(old) || got.Content != old.Content {
		t.Fatalf("rollback doc=%#v, want %#v", got, old)
	}
}

func TestDeleteDocWithExpectedHashAppendsTombstoneAndRollsBackAppendFailure(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("doc-delete-tombstone"); err != nil {
		t.Fatal(err)
	}
	doc := &models.Doc{Path: "delete-me", Title: "Delete", Content: "body"}
	if err := store.MutateDocWithHistory(context.Background(), nil, doc, DocMutationOptions{}); err != nil {
		t.Fatal(err)
	}
	current, err := store.Docs.Get(doc.Path)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteDocWithExpectedHash(context.Background(), doc.Path, DocDeleteOptions{ExpectedHash: current.CanonicalHash, Actor: "test", Source: "test"}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Docs.Get(doc.Path); err == nil {
		t.Fatal("canonical doc remains after durable tombstone")
	}
	stream, err := store.Versions.historyStore().Read(context.Background(), "doc", current.ID)
	if err != nil {
		t.Fatal(err)
	}
	head := stream.Records[len(stream.Records)-1]
	if len(stream.Records) != 2 || head.Operation != "delete" || !head.Tombstone || head.BaseHash != current.CanonicalHash || head.NewHash != current.CanonicalHash {
		t.Fatalf("delete history = %#v", stream.Records)
	}

	store = NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("doc-delete-rollback"); err != nil {
		t.Fatal(err)
	}
	doc = &models.Doc{Path: "rollback", Title: "Rollback", Content: "body"}
	if err := store.MutateDocWithHistory(context.Background(), nil, doc, DocMutationOptions{}); err != nil {
		t.Fatal(err)
	}
	current, err = store.Docs.Get(doc.Path)
	if err != nil {
		t.Fatal(err)
	}
	store.Versions.history = injectedHistoryStore(store.Root)
	if err := store.DeleteDocWithExpectedHash(context.Background(), doc.Path, DocDeleteOptions{ExpectedHash: current.CanonicalHash}); err == nil {
		t.Fatal("delete succeeded despite injected history append failure")
	}
	if restored, err := store.Docs.Get(doc.Path); err != nil || CanonicalDocHash(restored) != current.CanonicalHash {
		t.Fatalf("canonical rollback = %#v, %v", restored, err)
	}
}

func TestReconcileLifecycleRecoversInterruptedDocDeleteTransactionOnce(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("doc-delete-recovery"); err != nil {
		t.Fatal(err)
	}
	doc := &models.Doc{Path: "recover", Title: "Recover", Content: "body"}
	if err := store.MutateDocWithHistory(context.Background(), nil, doc, DocMutationOptions{}); err != nil {
		t.Fatal(err)
	}
	current, err := store.Docs.Get(doc.Path)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeDocDeleteTransaction(store.Root, docDeleteTransaction{SchemaVersion: 1, EntityID: current.ID, Path: "docs/recover.md", Hash: current.CanonicalHash, Timestamp: time.Now().UTC()}); err != nil {
		t.Fatal(err)
	}
	if err := store.Docs.Delete(doc.Path); err != nil {
		t.Fatal(err)
	}
	calls := 0
	r, err := NewFilesystemReconciler(store.Root, func(result ReconcileResult) error {
		if result.Operation == LifecycleOperationDelete {
			calls++
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	results, err := r.ReconcileLifecycle(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("delete callback count=%d results=%#v", calls, results)
	}
	stream, err := NewHistoryStore(store.Root).Read(context.Background(), "doc", current.ID)
	if err != nil || len(stream.Records) != 2 || !stream.Records[1].Tombstone {
		t.Fatalf("recovered history=%#v %v", stream, err)
	}
	if _, err := os.Stat(docDeleteTransactionPath(store.Root, current.ID)); !os.IsNotExist(err) {
		t.Fatalf("marker remains: %v", err)
	}
	_, err = r.ReconcileLifecycle(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("duplicate recovery callback=%d", calls)
	}
}

func TestReconcileLifecycleRejectsDocDeleteMarkerThroughSymlinkAncestor(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("doc-delete-symlink"); err != nil {
		t.Fatal(err)
	}
	doc := &models.Doc{Path: "safe", Title: "Safe", Content: "body"}
	if err := store.MutateDocWithHistory(context.Background(), nil, doc, DocMutationOptions{}); err != nil {
		t.Fatal(err)
	}
	current, err := store.Docs.Get(doc.Path)
	if err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	link := filepath.Join(store.Root, "docs", "linked")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	marker := docDeleteTransaction{SchemaVersion: 1, EntityID: current.ID, Path: "docs/linked/escape.md", Hash: current.CanonicalHash, Timestamp: time.Now().UTC()}
	if err := writeDocDeleteTransaction(store.Root, marker); err != nil {
		t.Fatal(err)
	}
	r, err := NewFilesystemReconciler(store.Root)
	if err != nil {
		t.Fatal(err)
	}
	results, err := r.ReconcileLifecycle(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}
	foundDiagnostic := false
	for _, result := range results {
		if strings.Contains(result.Diagnostic, "symlink ancestor") {
			foundDiagnostic = true
		}
	}
	if !foundDiagnostic {
		t.Fatalf("missing symlink diagnostic: %#v", results)
	}
	stream, err := NewHistoryStore(store.Root).Read(context.Background(), "doc", current.ID)
	if err != nil || len(stream.Records) != 1 {
		t.Fatalf("unsafe marker changed history: %#v, %v", stream.Records, err)
	}
	if _, err := os.Stat(docDeleteTransactionPath(store.Root, current.ID)); err != nil {
		t.Fatalf("unsafe marker was removed: %v", err)
	}
}

func TestReconcileLifecycleRejectsDocDeleteMarkerAtSymlinkTarget(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("doc-delete-target-symlink"); err != nil {
		t.Fatal(err)
	}
	doc := &models.Doc{Path: "safe", Title: "Safe", Content: "body"}
	if err := store.MutateDocWithHistory(context.Background(), nil, doc, DocMutationOptions{}); err != nil {
		t.Fatal(err)
	}
	current, err := store.Docs.Get(doc.Path)
	if err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "outside.md")
	if err := os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(store.Root, "docs", "linked.md")
	if err := os.Symlink(outside, target); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	marker := docDeleteTransaction{SchemaVersion: 1, EntityID: current.ID, Path: "docs/linked.md", Hash: current.CanonicalHash, Timestamp: time.Now().UTC()}
	if err := writeDocDeleteTransaction(store.Root, marker); err != nil {
		t.Fatal(err)
	}
	r, err := NewFilesystemReconciler(store.Root)
	if err != nil {
		t.Fatal(err)
	}
	results, err := r.ReconcileLifecycle(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}
	foundDiagnostic := false
	for _, result := range results {
		if strings.Contains(result.Diagnostic, "symlink target") {
			foundDiagnostic = true
		}
	}
	if !foundDiagnostic {
		t.Fatalf("missing final symlink diagnostic: %#v", results)
	}
	stream, err := NewHistoryStore(store.Root).Read(context.Background(), "doc", current.ID)
	if err != nil || len(stream.Records) != 1 {
		t.Fatalf("unsafe marker changed history: %#v, %v", stream.Records, err)
	}
	if _, err := os.Stat(docDeleteTransactionPath(store.Root, current.ID)); err != nil {
		t.Fatalf("unsafe marker was removed: %v", err)
	}
}

func TestReconcileLifecycleRejectsDocDeleteMarkerAtDanglingSymlinkTarget(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("doc-delete-dangling-symlink"); err != nil {
		t.Fatal(err)
	}
	doc := &models.Doc{Path: "safe", Title: "Safe", Content: "body"}
	if err := store.MutateDocWithHistory(context.Background(), nil, doc, DocMutationOptions{}); err != nil {
		t.Fatal(err)
	}
	current, err := store.Docs.Get(doc.Path)
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(store.Root, "docs", "dangling.md")
	if err := os.Symlink(filepath.Join(t.TempDir(), "missing.md"), target); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	marker := docDeleteTransaction{SchemaVersion: 1, EntityID: current.ID, Path: "docs/dangling.md", Hash: current.CanonicalHash, Timestamp: time.Now().UTC()}
	if err := writeDocDeleteTransaction(store.Root, marker); err != nil {
		t.Fatal(err)
	}
	r, err := NewFilesystemReconciler(store.Root)
	if err != nil {
		t.Fatal(err)
	}
	results, err := r.ReconcileLifecycle(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}
	foundDiagnostic := false
	for _, result := range results {
		if strings.Contains(result.Diagnostic, "symlink target") {
			foundDiagnostic = true
		}
	}
	if !foundDiagnostic {
		t.Fatalf("missing dangling symlink diagnostic: %#v", results)
	}
	stream, err := NewHistoryStore(store.Root).Read(context.Background(), "doc", current.ID)
	if err != nil || len(stream.Records) != 1 {
		t.Fatalf("dangling symlink changed history: %#v, %v", stream.Records, err)
	}
	if _, err := os.Stat(docDeleteTransactionPath(store.Root, current.ID)); err != nil {
		t.Fatalf("unsafe marker was removed: %v", err)
	}
}

func TestMutateDocWithHistoryRollsBackRenameAndReferences(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("doc-atomic-rename"); err != nil {
		t.Fatal(err)
	}
	old := &models.Doc{Path: "guides/old", Title: "Old", Content: "old"}
	ref := &models.Doc{Path: "guides/ref", Title: "Ref", Content: "See @doc/guides/old and @doc/guides/new."}
	if err := store.MutateDocWithHistory(context.Background(), nil, old, DocMutationOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := store.Docs.Create(ref); err != nil {
		t.Fatal(err)
	}
	task := &models.Task{ID: "rename-ref-task", Title: "Rename reference", Status: "todo", Priority: "medium",
		Description: "See @doc/guides/old and @doc/guides/new.", Spec: "guides/old",
		ImplementationPlan: "@doc/guides/old and @doc/guides/new", ImplementationNotes: "@doc/guides/old and @doc/guides/new"}
	if err := store.Tasks.Create(task); err != nil {
		t.Fatal(err)
	}
	memory := &models.MemoryEntry{ID: "rename-ref-memory", Title: "Rename reference", Layer: models.MemoryLayerProject,
		Category: "pattern", Content: "See @doc/guides/old and @doc/guides/new."}
	if err := store.Memory.Create(memory); err != nil {
		t.Fatal(err)
	}
	originalRefLoaded, err := store.Docs.Get(ref.Path)
	if err != nil {
		t.Fatal(err)
	}
	originalRef := *originalRefLoaded
	originalTaskLoaded, err := store.Tasks.Get(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	originalTask := *originalTaskLoaded
	originalMemoryLoaded, err := store.Memory.Get(memory.ID)
	if err != nil {
		t.Fatal(err)
	}
	originalMemory := *originalMemoryLoaded
	store.Versions.history = injectedHistoryStore(store.Root)
	renamed := *old
	renamed.Path = "guides/new"
	renamed.Content = "new"
	if err := store.MutateDocWithHistory(context.Background(), old, &renamed, DocMutationOptions{}); err == nil {
		t.Fatal("rename unexpectedly succeeded with injected history failure")
	}
	if _, err := store.Docs.Get("guides/new"); err == nil {
		t.Fatal("renamed Doc remained after failed history append")
	}
	if restored, err := store.Docs.Get("guides/old"); err != nil || restored.Content != old.Content {
		t.Fatalf("restored old Doc=%#v err=%v", restored, err)
	}
	restoredRef, err := store.Docs.Get(ref.Path)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(restoredRef, &originalRef) {
		t.Fatalf("restored reference=%#v, want %#v", restoredRef, &originalRef)
	}
	restoredTask, err := store.Tasks.Get(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(restoredTask, &originalTask) {
		t.Fatalf("restored task=%#v, want %#v", restoredTask, &originalTask)
	}
	restoredMemory, err := store.Memory.Get(memory.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(restoredMemory, &originalMemory) {
		t.Fatalf("restored memory=%#v, want %#v", restoredMemory, &originalMemory)
	}
}

func TestMutateDocWithHistoryRenamesReferencesWithPerEntityHistory(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("doc-rename-history"); err != nil {
		t.Fatal(err)
	}
	old := &models.Doc{Path: "guides/old", Title: "Old", Content: "old"}
	ref := &models.Doc{Path: "guides/ref", Title: "Ref", Content: "See @doc/guides/old."}
	if err := store.MutateDocWithHistory(context.Background(), nil, old, DocMutationOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := store.MutateDocWithHistory(context.Background(), nil, ref, DocMutationOptions{}); err != nil {
		t.Fatal(err)
	}
	task := &models.Task{ID: "rename-history-task", Title: "Rename history", Status: "todo", Priority: "medium", Description: "See @doc/guides/old", Spec: "guides/old"}
	if err := store.Tasks.Create(task); err != nil {
		t.Fatal(err)
	}
	renamed := *old
	renamed.Path = "guides/new"
	renamed.Content = "new"
	if err := store.MutateDocWithHistory(context.Background(), old, &renamed, DocMutationOptions{ExpectedHash: old.CanonicalHash}); err != nil {
		t.Fatalf("rename: %v", err)
	}
	if renamed.CanonicalHash == "" {
		t.Fatal("rename did not expose committed canonical hash")
	}
	gotRef, err := store.Docs.Get(ref.Path)
	if err != nil || gotRef.Content != "See @doc/guides/new." {
		t.Fatalf("rewritten ref=%#v err=%v", gotRef, err)
	}
	gotTask, err := store.Tasks.Get(task.ID)
	if err != nil || gotTask.Description != "See @doc/guides/new" || gotTask.Spec != "guides/new" {
		t.Fatalf("rewritten task=%#v err=%v", gotTask, err)
	}
	refHistory, err := store.Versions.GetDocHistory(ref.Path)
	if err != nil || len(refHistory.Versions) != 2 || refHistory.Versions[1].NewHash != CanonicalDocHash(gotRef) {
		t.Fatalf("reference history=%#v err=%v", refHistory, err)
	}
	taskHistory, err := store.Versions.GetHistory(task.ID)
	if err != nil || len(taskHistory.Versions) != 1 || taskHistory.Versions[0].NewHash != CanonicalTaskHash(gotTask) {
		t.Fatalf("task history=%#v err=%v", taskHistory, err)
	}
}

func TestRenameReferenceRewriteRejectsConcurrentTaskEdit(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("doc-rename-task-race"); err != nil {
		t.Fatal(err)
	}
	old := &models.Doc{Path: "guides/old", Title: "Old", Content: "old"}
	ref := &models.Doc{Path: "guides/ref", Title: "Ref", Content: "See @doc/guides/old."}
	if err := store.MutateDocWithHistory(context.Background(), nil, old, DocMutationOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := store.MutateDocWithHistory(context.Background(), nil, ref, DocMutationOptions{}); err != nil {
		t.Fatal(err)
	}
	task := &models.Task{ID: "rename-task-race", Title: "Race", Status: "todo", Priority: "medium", Description: "@doc/guides/old"}
	if err := store.Tasks.Create(task); err != nil {
		t.Fatal(err)
	}
	reached := make(chan struct{})
	release := make(chan struct{})
	store.renameReferencePreflight = func() { close(reached); <-release }
	renamed := *old
	renamed.Path = "guides/new"
	result := make(chan error, 1)
	go func() {
		result <- store.MutateDocWithHistory(context.Background(), old, &renamed, DocMutationOptions{ExpectedHash: old.CanonicalHash})
	}()
	<-reached
	if err := store.WithTaskLifecycleTransaction(context.Background(), func(tx *TaskLifecycleTransaction) error {
		current, err := tx.GetTask(task.ID)
		if err != nil {
			return err
		}
		before := cloneTask(current)
		current.Description = "edited concurrently"
		current.UpdatedAt = time.Now().UTC()
		if err := tx.UpdateTask(current); err != nil {
			return err
		}
		return tx.SaveTaskVersion(&before, current, "test", current.UpdatedAt, "task-edit")
	}); err != nil {
		t.Fatal(err)
	}
	close(release)
	if err := <-result; err == nil || !errors.Is(err, ErrHistoryConflict) {
		t.Fatalf("rename result=%v, want conflict", err)
	}
	if _, err := store.Docs.Get("guides/new"); err == nil {
		t.Fatal("failed rename created target Doc")
	}
	gotTask, _ := store.Tasks.Get(task.ID)
	if gotTask.Description != "edited concurrently" {
		t.Fatalf("concurrent Task edit was lost: %#v", gotTask)
	}
}

func TestRenameReferenceRewriteRejectsConcurrentDocEdit(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("doc-rename-doc-race"); err != nil {
		t.Fatal(err)
	}
	old := &models.Doc{Path: "guides/old", Title: "Old", Content: "old"}
	ref := &models.Doc{Path: "guides/ref", Title: "Ref", Content: "See @doc/guides/old."}
	if err := store.MutateDocWithHistory(context.Background(), nil, old, DocMutationOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := store.MutateDocWithHistory(context.Background(), nil, ref, DocMutationOptions{}); err != nil {
		t.Fatal(err)
	}
	reached := make(chan struct{})
	release := make(chan struct{})
	store.renameReferencePreflight = func() { close(reached); <-release }
	renamed := *old
	renamed.Path = "guides/new"
	result := make(chan error, 1)
	go func() {
		result <- store.MutateDocWithHistory(context.Background(), old, &renamed, DocMutationOptions{ExpectedHash: old.CanonicalHash})
	}()
	<-reached
	current, err := store.Docs.Get(ref.Path)
	if err != nil {
		t.Fatal(err)
	}
	updated := *current
	updated.Content = "edited concurrently"
	if err := store.MutateDocWithHistory(context.Background(), current, &updated, DocMutationOptions{ExpectedHash: current.CanonicalHash}); err != nil {
		t.Fatal(err)
	}
	close(release)
	if err := <-result; err == nil || !errors.Is(err, ErrHistoryConflict) {
		t.Fatalf("rename result=%v, want conflict", err)
	}
	if _, err := store.Docs.Get("guides/new"); err == nil {
		t.Fatal("failed rename created target Doc")
	}
	gotRef, _ := store.Docs.Get(ref.Path)
	if gotRef.Content != "edited concurrently" {
		t.Fatalf("concurrent Doc edit was lost: %#v", gotRef)
	}
}

func TestRenameReferenceRewriteMergesConcurrentMemoryEdit(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("doc-rename-memory-race"); err != nil {
		t.Fatal(err)
	}
	old := &models.Doc{Path: "guides/old", Title: "Old", Content: "old"}
	if err := store.MutateDocWithHistory(context.Background(), nil, old, DocMutationOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := store.Memory.Create(&models.MemoryEntry{ID: "rename-memory-race", Title: "Original", Layer: models.MemoryLayerProject, Category: "pattern", Content: "See @doc/guides/old."}); err != nil {
		t.Fatal(err)
	}
	reached := make(chan struct{})
	release := make(chan struct{})
	store.renameReferencePreflight = func() { close(reached); <-release }
	renamed := *old
	renamed.Path = "guides/new"
	result := make(chan error, 1)
	go func() {
		result <- store.MutateDocWithHistory(context.Background(), old, &renamed, DocMutationOptions{ExpectedHash: old.CanonicalHash})
	}()
	<-reached
	concurrent, err := store.Memory.Get("rename-memory-race")
	if err != nil {
		t.Fatal(err)
	}
	concurrent.Title = "Edited concurrently"
	concurrent.Metadata = map[string]string{"owner": "concurrent"}
	if err := store.Memory.Update(concurrent); err != nil {
		t.Fatal(err)
	}
	close(release)
	if err := <-result; err != nil {
		t.Fatalf("rename result=%v", err)
	}
	got, err := store.Memory.Get("rename-memory-race")
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "Edited concurrently" || got.Metadata["owner"] != "concurrent" || got.Content != "See @doc/guides/new." {
		t.Fatalf("concurrent memory edit was not merged: %#v", got)
	}
}

func TestConcurrentDocMutationsRejectStaleWriter(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	storeA := NewStore(root)
	if err := storeA.Init("doc-concurrent"); err != nil {
		t.Fatal(err)
	}
	initial := &models.Doc{Path: "guides/concurrent", Title: "Concurrent", Content: "base"}
	if err := storeA.MutateDocWithHistory(context.Background(), nil, initial, DocMutationOptions{}); err != nil {
		t.Fatal(err)
	}
	storeB := NewStore(root)
	oldA, err := storeA.Docs.Get(initial.Path)
	if err != nil {
		t.Fatal(err)
	}
	oldB, err := storeB.Docs.Get(initial.Path)
	if err != nil {
		t.Fatal(err)
	}
	candidateA := *oldA
	candidateA.Content = "winner-a"
	candidateB := *oldB
	candidateB.Content = "winner-b"
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for _, pair := range []struct {
		store *Store
		old   *models.Doc
		new   *models.Doc
	}{{storeA, oldA, &candidateA}, {storeB, oldB, &candidateB}} {
		wg.Add(1)
		go func(pair struct {
			store *Store
			old   *models.Doc
			new   *models.Doc
		}) {
			defer wg.Done()
			results <- pair.store.MutateDocWithHistory(context.Background(), pair.old, pair.new, DocMutationOptions{})
		}(pair)
	}
	wg.Wait()
	close(results)
	successes, conflicts := 0, 0
	for err := range results {
		if err == nil {
			successes++
		} else if errors.Is(err, ErrHistoryConflict) {
			conflicts++
		} else {
			t.Fatalf("concurrent mutation error=%v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("successes=%d conflicts=%d, want one each", successes, conflicts)
	}
	final, err := storeA.Docs.Get(initial.Path)
	if err != nil {
		t.Fatal(err)
	}
	history, err := storeA.Versions.GetDocHistory(initial.Path)
	if err != nil || len(history.Versions) != 2 {
		t.Fatalf("history=%#v err=%v", history, err)
	}
	if hashDoc(final) != history.Versions[1].NewHash {
		t.Fatalf("canonical hash=%q history head=%q", hashDoc(final), history.Versions[1].NewHash)
	}
}
