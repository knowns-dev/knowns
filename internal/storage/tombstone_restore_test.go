package storage

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

func tombstoneRestoreTaskStore(t *testing.T, id string) (*Store, *FilesystemReconciler, models.HistoryRecord) {
	t.Helper()
	ctx := context.Background()
	root := filepath.Join(t.TempDir(), ".knowns")
	store := NewStore(root)
	if err := store.Init("tombstone-restore"); err != nil {
		t.Fatal(err)
	}
	lifecycleTaskFile(t, root, "alive", id, "Alive")
	r, err := NewFilesystemReconciler(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.ReconcileLifecycle(ctx, true); err != nil {
		t.Fatal(err)
	}
	live := reappearedHead(t, r, "task", id)
	if err := r.appendHistoryRecord(ctx, models.HistoryRecord{
		EntityType: "task", EntityID: id, Source: "watcher", Operation: LifecycleOperationDelete,
		Tombstone: true, Timestamp: time.Now().UTC(), BaseHash: live.NewHash, NewHash: live.NewHash,
		Checkpoint: true, CheckpointPayload: live.CheckpointPayload, CurrentPath: "tasks/alive.md",
	}); err != nil {
		t.Fatal(err)
	}
	return store, r, live
}

func TestPlanAndRestoreATombstonedTask(t *testing.T) {
	ctx := context.Background()
	store, r, live := tombstoneRestoreTaskStore(t, "planned")

	plan, err := store.PlanTombstoneRestore("task", "planned")
	if err != nil {
		t.Fatal(err)
	}
	if !plan.Tombstoned || !plan.FilePresent || plan.Path != "tasks/alive.md" || plan.Hash != live.NewHash {
		t.Fatalf("plan = %+v, want a tombstoned Task at tasks/alive.md with its file present", plan)
	}
	result, err := store.RestoreTombstoned(ctx, plan, "test")
	if err != nil {
		t.Fatal(err)
	}
	if result.Operation != LifecycleOperationRestore || !result.Changed {
		t.Fatalf("restore result = %+v, want a durable restore", result)
	}
	if head := reappearedHead(t, r, "task", "planned"); head.Tombstone || head.Operation != LifecycleOperationRestore {
		t.Fatalf("history head = %+v, want a restore", head)
	}

	again, err := store.PlanTombstoneRestore("task", "planned")
	if err != nil {
		t.Fatal(err)
	}
	if again.Tombstoned {
		t.Fatalf("plan after restore = %+v, want not tombstoned", again)
	}
	if _, err := store.RestoreTombstoned(ctx, again, "test"); !errors.Is(err, ErrNotTombstoned) {
		t.Fatalf("restoring a live Task: err = %v, want ErrNotTombstoned", err)
	}
}

func TestRestoreTombstonedRefusesForeignContentAtThePath(t *testing.T) {
	ctx := context.Background()
	store, _, _ := tombstoneRestoreTaskStore(t, "occupied")
	path := lifecycleTaskFile(t, store.Root, "alive", "occupied", "Rewritten By Something Else")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := store.PlanTombstoneRestore("task", "occupied")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.RestoreTombstoned(ctx, plan, "test"); !errors.Is(err, ErrReconcileUnsafe) {
		t.Fatalf("restore over foreign content: err = %v, want ErrReconcileUnsafe", err)
	}
	after, err := os.ReadFile(path)
	if err != nil || string(after) != string(before) {
		t.Fatalf("refused restore touched the file: err=%v", err)
	}
}

func TestPlanTombstoneRestoreRejectsUnknownEntityType(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("tombstone-restore"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.PlanTombstoneRestore("memory", "x"); err == nil {
		t.Fatal("plan accepted an entity type it cannot restore")
	}
}

func TestPlanAndRestoreADeletedDocKeepsItsContent(t *testing.T) {
	ctx := context.Background()
	// The head is a section-scoped revision, whose display snapshot has no
	// content. A restore built from that snapshot would bring back an empty Doc.
	store, doc := newReappearedDocStore(t)
	content := doc.Content
	if err := store.DeleteDocWithExpectedHash(ctx, "guides/returned", DocDeleteOptions{ExpectedHash: CanonicalDocHash(doc), Actor: "test", Source: "test"}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(store.Root, "docs", "guides", "returned.md")
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("delete left the file: %v", err)
	}
	plan, err := store.PlanTombstoneRestore("doc", "guides/returned")
	if err != nil {
		t.Fatal(err)
	}
	if plan.EntityID != doc.ID || !plan.Tombstoned || plan.FilePresent || plan.Path != "docs/guides/returned.md" {
		t.Fatalf("plan = %+v, want the deleted Doc found through its history", plan)
	}
	if _, err := store.RestoreTombstoned(ctx, plan, "test"); err != nil {
		t.Fatal(err)
	}
	restored, err := store.Docs.Get("guides/returned")
	if err != nil || restored.Content != content {
		t.Fatalf("restored Doc = %+v err=%v, want content %q", restored, err, content)
	}
}
