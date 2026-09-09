package search

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/runtimequeue"
	"github.com/howznguyen/knowns/internal/storage"
)

// TestMain neutralises the managed-Qdrant start seam for this whole package.
// Tests here configure stores with the Qdrant backend, and an unset mode
// resolves to managed against the machine-level ~/.knowns/runtime/qdrant, so
// an unstubbed seam would let a unit test start a real process on the
// developer's machine and quietly index into their live runtime.
func TestMain(m *testing.M) {
	ensureManagedQdrant = func(context.Context, models.SemanticVectorStoreResolution) error { return nil }
	os.Exit(m.Run())
}

// stubEnsure swaps the seam for one test and restores it afterwards.
func stubEnsure(t *testing.T, fn func(context.Context, models.SemanticVectorStoreResolution) error) {
	t.Helper()
	previous := ensureManagedQdrant
	ensureManagedQdrant = fn
	t.Cleanup(func() { ensureManagedQdrant = previous })
}

// provableTaskIntent builds the durable intent the real hook would queue for a
// task: a store, the canonical file, a history head, and the queued job's own
// Intent. Hand-built intents fail the durability proof in
// ExecuteQdrantReconciliation and return before reaching anything this file is
// about, so the fixture has to be the real one.
func provableTaskIntent(t *testing.T, store *storage.Store, id, title string) runtimequeue.QdrantIntent {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(store.Root, "tasks"), 0o755); err != nil {
		t.Fatal(err)
	}
	name := "task-" + id + " - " + title + ".md"
	front := "---\nid: " + id + "\ntitle: " + title + "\nstatus: todo\npriority: medium\nlabels: []\n---\n"
	if err := os.WriteFile(filepath.Join(store.Root, "tasks", name), []byte(front), 0o644); err != nil {
		t.Fatal(err)
	}
	task, err := store.Tasks.Get(id)
	if err != nil {
		t.Fatal(err)
	}
	record := models.HistoryRecord{
		EntityType: "task", EntityID: id, Operation: "update",
		NewHash: storage.CanonicalTaskHash(task), Checkpoint: true,
		CheckpointPayload: map[string]any{"id": id, "title": title, "status": "todo", "priority": "medium"},
	}
	if err := storage.NewHistoryStore(store.Root).Append(context.Background(), record); err != nil {
		t.Fatal(err)
	}
	BestEffortIndexTask(store, id)
	queue, err := runtimequeue.LoadQueue(store.Root)
	if err != nil {
		t.Fatal(err)
	}
	if len(queue.Jobs) != 1 || queue.Jobs[0].Intent == nil {
		t.Fatalf("queue = %#v, want exactly one job carrying a durable intent", queue.Jobs)
	}
	intent := *queue.Jobs[0].Intent
	if ok, err := proveQdrantIntent(store.Root, intent); err != nil || !ok {
		t.Fatalf("fixture intent is not provable (ok=%v err=%v), so the test would pass vacuously", ok, err)
	}
	return intent
}

func TestTargetedReconciliationEnsuresQdrantBeforeReachingIt(t *testing.T) {
	// The managed process has no supervisor, so a reconcile job that assumes
	// Qdrant is up fails with connection refused after any reboot and burns its
	// retry budget. This asserts the job goes through the start seam first.
	store := configureSemanticStore(t, &models.SemanticVectorStoreSettings{Backend: models.SemanticVectorBackendQdrant})
	intent := provableTaskIntent(t, store, "ensure", "Ensure")
	if err := SaveQdrantPointer(store.Root, targetedPointer(t, store.Root)); err != nil {
		t.Fatal(err)
	}

	// Returning a distinctive error proves both that the seam was reached and
	// that it was reached before anything else could fail: every other failure
	// on this path reports a different error.
	sentinel := errors.New("managed Qdrant refused to start")
	calls := 0
	stubEnsure(t, func(_ context.Context, res models.SemanticVectorStoreResolution) error {
		calls++
		if res.Backend != models.SemanticVectorBackendQdrant {
			t.Fatalf("ensure received backend %q, want the resolved qdrant configuration", res.Backend)
		}
		return sentinel
	})

	err := ExecuteQdrantReconciliation(context.Background(), store.Root, intent)
	if !errors.Is(err, sentinel) {
		t.Fatalf("error = %v, want the ensure failure surfaced to the job", err)
	}
	if calls != 1 {
		t.Fatalf("ensure calls = %d, want exactly one", calls)
	}
}

func TestUnprovisionedReconciliationStartsNothing(t *testing.T) {
	// A store mid-migration skips targeted reconciliation entirely. It has no
	// destination to write to, so starting a backend for it would be pure cost
	// on a path that was always going to return early.
	store := configureSemanticStore(t, &models.SemanticVectorStoreSettings{Backend: models.SemanticVectorBackendQdrant})
	intent := provableTaskIntent(t, store, "unprov", "Unprovisioned")
	if pointer, err := LoadQdrantPointer(store.Root); err != nil || pointer != nil {
		t.Fatalf("pointer = %#v, err=%v, want the unprovisioned fixture this case needs", pointer, err)
	}

	stubEnsure(t, func(context.Context, models.SemanticVectorStoreResolution) error {
		t.Fatal("an unprovisioned store started the managed backend")
		return nil
	})

	if err := ExecuteQdrantReconciliation(context.Background(), store.Root, intent); err != nil {
		t.Fatalf("unprovisioned reconciliation failed: %v", err)
	}
}
