package storage

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

func lifecycleTaskFile(t *testing.T, root, name, id, title string) string {
	t.Helper()
	path := filepath.Join(root, "tasks", name+".md")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	data := []byte("---\nid: " + id + "\ntitle: " + title + "\nstatus: todo\npriority: medium\nlabels: []\n---\n")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLifecycleRenameDeleteRestore(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	old := lifecycleTaskFile(t, root, "a", "life-1", "A")
	r, err := NewFilesystemReconciler(root)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	r.SetLifecycleClock(func() time.Time { return now })
	deleteResults, err := r.ReconcileLifecycle(context.Background(), true)
	t.Logf("delete results=%+v err=%v", deleteResults, err)
	if err != nil {
		t.Fatal(err)
	}
	newPath := filepath.Join(root, "tasks", "b.md")
	if err := os.Rename(old, newPath); err != nil {
		t.Fatal(err)
	}
	results, err := r.ReconcileLifecycle(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Operation != LifecycleOperationRename {
		t.Fatalf("rename results=%+v", results)
	}
	stream, err := r.history.Read(context.Background(), "task", "life-1")
	if err != nil || len(stream.Records) != 2 || stream.Records[1].PreviousPath != "tasks/a.md" || stream.Records[1].CurrentPath != "tasks/b.md" {
		t.Fatalf("rename stream=%+v err=%v", stream.Records, err)
	}
	if err := os.Remove(newPath); err != nil {
		t.Fatal(err)
	}
	// The first Remove observation is only a pending absence; advance the
	// deterministic watcher quiet window before the destructive pass.
	if _, err := r.ReconcileLifecycle(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	now = now.Add(ReconcileQuietWindow)
	results, err = r.ReconcileLifecycle(context.Background(), true)
	if err != nil || len(results) != 1 || results[0].Operation != LifecycleOperationDelete {
		t.Fatalf("delete results=%+v err=%v", results, err)
	}
	stream, err = r.history.Read(context.Background(), "task", "life-1")
	if err != nil || len(stream.Records) != 3 || !stream.Records[2].Tombstone {
		t.Fatalf("tombstone stream=%+v err=%v", stream.Records, err)
	}
	if _, err := r.Restore(context.Background(), "task", "life-1", RestoreOptions{Path: "tasks/b.md"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(newPath); err != nil {
		t.Fatalf("restore path: %v", err)
	}
}

func TestLifecycleDeleteReportsPendingThenWaitRetriesFromDurableObservation(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	path := lifecycleTaskFile(t, root, "pending", "pending-delete", "Pending")
	r, err := NewFilesystemReconciler(root)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	r.SetLifecycleClock(func() time.Time { return now })
	if _, err := r.ReconcileLifecycle(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	results, err := r.ReconcileLifecycle(context.Background(), true)
	if err != nil || len(results) != 1 || !results[0].Pending || results[0].RetryAt.IsZero() {
		t.Fatalf("pending result=%+v err=%v", results, err)
	}
	now = now.Add(ReconcileQuietWindow)
	results, err = r.ReconcileLifecycleWithOptions(context.Background(), true, LifecycleOptions{Source: "startup", Wait: true})
	if err != nil || len(results) != 1 || results[0].Operation != LifecycleOperationDelete {
		t.Fatalf("wait retry result=%+v err=%v", results, err)
	}
}

func TestLifecycleHardDeleteRequiresProofAndPurgesExactHistory(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	lifecycleTaskFile(t, root, "a", "purge-1", "A")
	r, err := NewFilesystemReconciler(root)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	r.SetLifecycleClock(func() time.Time { return now })
	if _, err := r.ReconcileLifecycle(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if err := r.HardDelete(context.Background(), "task", "purge-1", HardDeleteOptions{Confirmed: true, Reason: "privacy"}); err == nil {
		t.Fatal("untrusted purge succeeded")
	}
	if err := r.HardDelete(context.Background(), "task", "purge-1", HardDeleteOptions{Trusted: true, Confirmed: true, Reason: "privacy", ExpectedHash: "wrong"}); err == nil {
		t.Fatal("wrong hash purge succeeded")
	}
	if err := r.HardDelete(context.Background(), "task", "purge-1", HardDeleteOptions{Trusted: true, Confirmed: true, Reason: "privacy"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(r.history.EntityPath("task", "purge-1")); !os.IsNotExist(err) {
		t.Fatalf("history remains: %v", err)
	}
	if _, ok := (&reconcileManifest{}).Entries[manifestKey("task", "purge-1")]; ok {
		t.Fatal("impossible")
	}
	_ = models.Task{}
}

func TestLifecycleHardDeleteReservationRetryRemovesCanonicalAndHistory(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	canonical := lifecycleTaskFile(t, root, "recover", "purge-retry", "Recover")
	var handoffs int
	r, err := NewFilesystemReconciler(root, func(result ReconcileResult) error {
		if result.Operation == LifecycleOperationHardDelete {
			handoffs++
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.ReconcileLifecycle(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	stream, err := r.history.Read(context.Background(), "task", "purge-retry")
	if err != nil || len(stream.Records) != 1 {
		t.Fatalf("history=%+v err=%v", stream.Records, err)
	}
	failOnce := true
	r.SetLifecycleFailureHooks(LifecycleFailureHooks{BeforeCanonicalRemove: func(_, _, _ string) error {
		if failOnce {
			failOnce = false
			return errors.New("injected crash before canonical removal")
		}
		return nil
	}})
	opts := HardDeleteOptions{Trusted: true, Confirmed: true, Reason: "privacy retry", Actor: "test", ExpectedHash: stream.Records[0].NewHash}
	if err := r.HardDelete(context.Background(), "task", "purge-retry", opts); err == nil {
		t.Fatal("injected purge unexpectedly succeeded")
	}
	reservation := r.purgeReservationPath("task", "purge-retry")
	if _, err := os.Stat(reservation); err != nil {
		t.Fatalf("reservation missing after injected failure: %v", err)
	}
	if _, err := os.Stat(canonical); err != nil {
		t.Fatalf("canonical removed before retry: %v", err)
	}
	if _, err := r.history.Read(context.Background(), "task", "purge-retry"); err != nil {
		t.Fatalf("history removed before retry: %v", err)
	}
	if err := r.HardDelete(context.Background(), "task", "purge-retry", opts); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(canonical); !os.IsNotExist(err) {
		t.Fatalf("canonical remains after retry: %v", err)
	}
	if _, err := os.Stat(r.history.EntityPath("task", "purge-retry")); !os.IsNotExist(err) {
		t.Fatalf("JSONL remains after retry: %v", err)
	}
	if handoffs != 1 {
		t.Fatalf("hard-delete handoffs=%d, want one", handoffs)
	}
	if _, err := os.Stat(reservation); err != nil {
		t.Fatalf("content-free audit reservation missing after purge: %v", err)
	}
}

func TestLifecycleHardDeleteReservationRejectsMovedIdentityOnRetry(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	canonical := lifecycleTaskFile(t, root, "reserved", "purge-moved-retry", "Reserved")
	r, err := NewFilesystemReconciler(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.ReconcileLifecycle(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	stream, err := r.history.Read(context.Background(), "task", "purge-moved-retry")
	if err != nil || len(stream.Records) != 1 {
		t.Fatalf("history=%+v err=%v", stream.Records, err)
	}
	first := true
	r.SetLifecycleFailureHooks(LifecycleFailureHooks{BeforeCanonicalRemove: func(_, _, _ string) error {
		if first {
			first = false
			return errors.New("injected reservation crash")
		}
		return nil
	}})
	opts := HardDeleteOptions{Trusted: true, Confirmed: true, Reason: "privacy", ExpectedHash: stream.Records[0].NewHash}
	if err := r.HardDelete(context.Background(), "task", "purge-moved-retry", opts); err == nil {
		t.Fatal("initial purge unexpectedly succeeded")
	}
	moved := filepath.Join(root, "tasks", "moved-after-reservation.md")
	if err := os.Rename(canonical, moved); err != nil {
		t.Fatal(err)
	}
	if err := r.HardDelete(context.Background(), "task", "purge-moved-retry", opts); err == nil {
		t.Fatal("retry purged an identity moved after reservation")
	}
	if _, err := os.Stat(moved); err != nil {
		t.Fatalf("moved canonical was removed: %v", err)
	}
	if _, err := r.history.Read(context.Background(), "task", "purge-moved-retry"); err != nil {
		t.Fatalf("history changed after rejected retry: %v", err)
	}
}

func TestLifecycleHardDeleteRejectsMovedActiveCanonical(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	old := lifecycleTaskFile(t, root, "moved", "purge-moved", "Moved")
	r, err := NewFilesystemReconciler(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.ReconcileLifecycle(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	stream, err := r.history.Read(context.Background(), "task", "purge-moved")
	if err != nil || len(stream.Records) != 1 {
		t.Fatalf("history=%+v err=%v", stream.Records, err)
	}
	moved := filepath.Join(root, "tasks", "moved-elsewhere.md")
	if err := os.Rename(old, moved); err != nil {
		t.Fatal(err)
	}
	if err := r.HardDelete(context.Background(), "task", "purge-moved", HardDeleteOptions{Trusted: true, Confirmed: true, Reason: "privacy", ExpectedHash: stream.Records[0].NewHash}); err == nil {
		t.Fatal("purge succeeded after active canonical moved")
	}
	if _, err := os.Stat(moved); err != nil {
		t.Fatalf("moved canonical was removed: %v", err)
	}
	after, err := r.history.Read(context.Background(), "task", "purge-moved")
	if err != nil || len(after.Records) != len(stream.Records) {
		t.Fatalf("history changed after rejected purge: %+v err=%v", after.Records, err)
	}
	manifest, err := r.readManifest()
	if err != nil || manifest.Entries[manifestKey("task", "purge-moved")].Path != "tasks/moved.md" {
		t.Fatalf("manifest changed after rejected purge: %+v err=%v", manifest.Entries[manifestKey("task", "purge-moved")], err)
	}
}

func TestLifecycleRestoreConcurrentInstancesHaveOneWinner(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	original := lifecycleTaskFile(t, root, "restore-race", "restore-race", "Restore")
	r1, err := NewFilesystemReconciler(root)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	r1.SetLifecycleClock(func() time.Time { return now })
	if _, err := r1.ReconcileLifecycle(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(original); err != nil {
		t.Fatal(err)
	}
	if _, err := r1.ReconcileLifecycle(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	now = now.Add(ReconcileQuietWindow)
	if _, err := r1.ReconcileLifecycle(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	stream, err := r1.history.Read(context.Background(), "task", "restore-race")
	if err != nil || len(stream.Records) != 2 {
		t.Fatalf("tombstone history=%+v err=%v", stream.Records, err)
	}
	r2, err := NewFilesystemReconciler(root)
	if err != nil {
		t.Fatal(err)
	}
	baseHash := stream.Records[len(stream.Records)-1].NewHash
	results := make(chan error, 3)
	var wg sync.WaitGroup
	for _, path := range []string{"tasks/restore-winner.md", "tasks/restore-loser.md"} {
		wg.Add(1)
		go func(path string) {
			defer wg.Done()
			_, restoreErr := r1.Restore(context.Background(), "task", "restore-race", RestoreOptions{Path: path, ExpectedBaseHash: baseHash})
			results <- restoreErr
		}(path)
	}
	// Exercise two independent reconciler instances as well; the lifecycle
	// lock is project-local and must serialize both processes.
	wg.Add(1)
	go func() {
		defer wg.Done()
		_, restoreErr := r2.Restore(context.Background(), "task", "restore-race", RestoreOptions{Path: "tasks/restore-second.md", ExpectedBaseHash: baseHash})
		results <- restoreErr
	}()
	wg.Wait()
	close(results)
	successes := 0
	for restoreErr := range results {
		if restoreErr == nil {
			successes++
		}
	}
	if successes != 1 {
		t.Fatalf("restore successes=%d, want one", successes)
	}
	manifest, err := r1.readManifest()
	if err != nil {
		t.Fatal(err)
	}
	winner := manifest.Entries[manifestKey("task", "restore-race")].Path
	if winner == "" {
		t.Fatal("restore did not activate manifest winner")
	}
	if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(winner))); err != nil {
		t.Fatalf("manifest winner missing: %v", err)
	}
	for _, path := range []string{"tasks/restore-winner.md", "tasks/restore-loser.md", "tasks/restore-second.md"} {
		if path != winner {
			if _, statErr := os.Stat(filepath.Join(root, filepath.FromSlash(path))); statErr == nil {
				t.Fatalf("loser canonical remains: %s", path)
			}
		}
	}
}

func TestTaskHistoryPurgeLegacyOnlyRequiresIdentityProof(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	store := NewStore(root)
	if err := store.Init("legacy-purge"); err != nil {
		t.Fatal(err)
	}
	verifiedPath := store.Versions.versionPath("legacy-only")
	if err := writeJSON(verifiedPath, map[string]any{"taskId": "legacy-only", "versions": []any{map[string]any{"version": 1}}}); err != nil {
		t.Fatal(err)
	}
	if err := store.WithTaskLifecycleTransaction(context.Background(), func(tx *TaskLifecycleTransaction) error {
		return tx.PurgeTaskVersionHistory("legacy-only", "tester", "privacy", "")
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(verifiedPath); !os.IsNotExist(err) {
		t.Fatalf("verified legacy history retained: %v", err)
	}
	mismatchPath := store.Versions.versionPath("legacy-mismatch")
	if err := writeJSON(mismatchPath, map[string]any{"taskId": "different", "versions": []any{map[string]any{"version": 1}}}); err != nil {
		t.Fatal(err)
	}
	if err := store.WithTaskLifecycleTransaction(context.Background(), func(tx *TaskLifecycleTransaction) error {
		return tx.PurgeTaskVersionHistory("legacy-mismatch", "tester", "privacy", "")
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(mismatchPath); err != nil {
		t.Fatalf("mismatched legacy history was removed: %v", err)
	}
}

func TestLifecycleSamePathUpdateAndRetryHandoffs(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	path := lifecycleTaskFile(t, root, "a", "update-1", "A")
	var calls int
	fail := true
	r, err := NewFilesystemReconciler(root, func(ReconcileResult) error {
		calls++
		if fail {
			return os.ErrPermission
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.ReconcileLifecycle(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	// Initial handoff fails but history is durable; the next pass retries it.
	fail = false
	if _, err := r.ReconcileLifecycle(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("---\nid: update-1\ntitle: B\nstatus: todo\npriority: medium\nlabels: []\n---\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	fail = true
	if _, err := r.ReconcileLifecycle(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	stream, err := r.history.Read(context.Background(), "task", "update-1")
	if err != nil || len(stream.Records) != 2 || stream.Records[1].BatchID == "" {
		t.Fatalf("update history=%+v err=%v", stream.Records, err)
	}
	fail = false
	if _, err := r.ReconcileLifecycle(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	stream, err = r.history.Read(context.Background(), "task", "update-1")
	if err != nil || len(stream.Records) != 2 {
		t.Fatalf("retry duplicated history=%+v err=%v", stream.Records, err)
	}
	if calls < 3 {
		t.Fatalf("handoff calls=%d, want retries", calls)
	}
}

func TestLifecycleHardDeleteTombstoneWithoutManifest(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	path := lifecycleTaskFile(t, root, "a", "purge-tomb", "A")
	r, err := NewFilesystemReconciler(root)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	r.SetLifecycleClock(func() time.Time { return now })
	if _, err := r.ReconcileLifecycle(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, err := r.ReconcileLifecycle(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	now = now.Add(ReconcileQuietWindow)
	if _, err := r.ReconcileLifecycle(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if err := r.HardDelete(context.Background(), "task", "purge-tomb", HardDeleteOptions{Trusted: true, Confirmed: true, Reason: "privacy"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(r.history.EntityPath("task", "purge-tomb")); !os.IsNotExist(err) {
		t.Fatalf("tombstone history remains: %v", err)
	}
}

func TestLifecycleRestoreRejectsTraversal(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	lifecycleTaskFile(t, root, "a", "restore-proof", "A")
	r, err := NewFilesystemReconciler(root)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	r.SetLifecycleClock(func() time.Time { return now })
	if _, err := r.ReconcileLifecycle(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(root, "tasks", "a.md")); err != nil {
		t.Fatal(err)
	}
	if _, err := r.ReconcileLifecycle(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Restore(context.Background(), "task", "restore-proof", RestoreOptions{Path: "../evil.md"}); err == nil {
		t.Fatal("traversal restore succeeded")
	}
}

func TestLifecycleSamePathReplacementTombstonesOldOwner(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	path := lifecycleTaskFile(t, root, "a", "old-owner", "A")
	r, err := NewFilesystemReconciler(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.ReconcileLifecycle(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("---\nid: new-owner\ntitle: N\nstatus: todo\npriority: medium\nlabels: []\n---\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := r.ReconcileLifecycle(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	oldStream, err := r.history.Read(context.Background(), "task", "old-owner")
	if err != nil || len(oldStream.Records) != 2 || !oldStream.Records[1].Tombstone {
		t.Fatalf("old owner history=%+v err=%v", oldStream.Records, err)
	}
	newStream, err := r.history.Read(context.Background(), "task", "new-owner")
	if err != nil || len(newStream.Records) != 1 {
		t.Fatalf("new owner history=%+v err=%v", newStream.Records, err)
	}
}

func TestLifecycleBatchOldRenameObservationFindsUnobservedNewPath(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	old := lifecycleTaskFile(t, root, "a", "event-rename", "A")
	r, err := NewFilesystemReconciler(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.ReconcileLifecycle(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	newPath := filepath.Join(root, "tasks", "b.md")
	if err := os.Rename(old, newPath); err != nil {
		t.Fatal(err)
	}
	results, err := r.ReconcileLifecycleBatch(context.Background(), LifecycleBatch{Source: "watcher", Hints: []ReconcileHint{{Path: old, Event: "rename"}}}, true)
	if err != nil || len(results) != 1 || results[0].Operation != LifecycleOperationRename {
		t.Fatalf("results=%+v err=%v", results, err)
	}
}

func TestLifecycleBatchIsBoundedAndSharesBatchID(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	const total = 520
	hints := make([]ReconcileHint, 0, total)
	for i := 0; i < total; i++ {
		name := fmt.Sprintf("bulk-%03d", i)
		path := lifecycleTaskFile(t, root, name, "bulk-id-"+name, name)
		hints = append(hints, ReconcileHint{Path: path, Event: "create"})
	}
	r, err := NewFilesystemReconciler(root)
	if err != nil {
		t.Fatal(err)
	}
	results, err := r.ReconcileLifecycleBatch(context.Background(), LifecycleBatch{Source: "import", Hints: hints, Limit: 128}, true)
	if err != nil {
		t.Fatal(err)
	}
	var processed int
	batchIDs := map[string]struct{}{}
	for _, result := range results {
		if result.Operation != "" && result.Diagnostic == "" {
			processed++
			batchIDs[result.BatchID] = struct{}{}
		}
	}
	if processed > 128 || len(batchIDs) != 1 {
		t.Fatalf("processed=%d batchIDs=%v", processed, batchIDs)
	}
	for _, result := range results {
		if result.Operation == "" || result.Diagnostic != "" {
			continue
		}
		stream, readErr := r.history.Read(context.Background(), result.EntityType, result.EntityID)
		if readErr != nil || len(stream.Records) != 1 || stream.Records[0].BatchID == "" || stream.Records[0].BatchID != result.BatchID {
			t.Fatalf("persisted batch metadata for %s: records=%+v result=%+v err=%v", result.EntityID, stream.Records, result, readErr)
		}
	}
	if len(results) == 0 {
		t.Fatal("bounded batch returned no diagnostics/results")
	}
}

func TestLifecycleProjectIsolationAndBatchMetadataAcrossUpdates(t *testing.T) {
	base := t.TempDir()
	type project struct {
		root string
		r    *FilesystemReconciler
		now  *time.Time
	}
	projects := make([]project, 2)
	for i := range projects {
		root := filepath.Join(base, fmt.Sprintf("project-%d", i), ".knowns")
		r, err := NewFilesystemReconciler(root)
		if err != nil {
			t.Fatal(err)
		}
		now := time.Now().UTC()
		clock := now
		r.SetLifecycleClock(func() time.Time { return clock })
		lifecycleTaskFile(t, root, "same", "same-id", fmt.Sprintf("project-%d", i))
		createResults, err := r.ReconcileLifecycle(context.Background(), true)
		if err != nil {
			t.Fatal(err)
		}
		if len(createResults) == 0 || createResults[0].Operation == "" || createResults[0].BatchID == "" {
			t.Fatalf("project %d create result=%+v", i, createResults)
		}
		projects[i] = project{root: root, r: r, now: &clock}
	}

	for i := range projects {
		p := &projects[i]
		oldPath := filepath.Join(p.root, "tasks", "same.md")
		newPath := filepath.Join(p.root, "tasks", "renamed.md")
		if err := os.Rename(oldPath, newPath); err != nil {
			t.Fatal(err)
		}
		renameResults, err := p.r.ReconcileLifecycle(context.Background(), true)
		if err != nil {
			t.Fatal(err)
		}
		var renameBatch string
		for _, result := range renameResults {
			if result.Operation == LifecycleOperationRename && result.Diagnostic == "" {
				renameBatch = result.BatchID
			}
		}
		if renameBatch == "" {
			t.Fatalf("project %d rename result=%+v", i, renameResults)
		}
		data := []byte("---\nid: same-id\ntitle: edited\nstatus: todo\npriority: medium\nlabels: []\n---\n")
		if err := os.WriteFile(newPath, data, 0o644); err != nil {
			t.Fatal(err)
		}
		updateResults, err := p.r.ReconcileLifecycle(context.Background(), true)
		if err != nil {
			t.Fatal(err)
		}
		var updateBatch string
		for _, result := range updateResults {
			if result.Operation == LifecycleOperationUpdate && result.Diagnostic == "" {
				updateBatch = result.BatchID
			}
		}
		if updateBatch == "" {
			t.Fatalf("project %d update result=%+v", i, updateResults)
		}
		if err := os.Remove(newPath); err != nil {
			t.Fatal(err)
		}
		if _, err := p.r.ReconcileLifecycle(context.Background(), true); err != nil {
			t.Fatal(err)
		}
		*p.now = p.now.Add(ReconcileQuietWindow)
		deleteResults, err := p.r.ReconcileLifecycle(context.Background(), true)
		if err != nil {
			t.Fatal(err)
		}
		var deleteBatch string
		for _, result := range deleteResults {
			if result.Operation == LifecycleOperationDelete && result.Diagnostic == "" {
				deleteBatch = result.BatchID
			}
		}
		if deleteBatch == "" {
			t.Fatalf("project %d delete result=%+v", i, deleteResults)
		}
		stream, err := p.r.history.Read(context.Background(), "task", "same-id")
		if err != nil || len(stream.Records) != 4 {
			t.Fatalf("project %d records=%+v err=%v", i, stream.Records, err)
		}
		for _, record := range stream.Records {
			if record.BatchID == "" {
				t.Fatalf("project %d record missing batch id: %+v", i, record)
			}
		}
		if stream.Records[1].BatchID != renameBatch || stream.Records[2].BatchID != updateBatch || stream.Records[3].BatchID != deleteBatch {
			t.Fatalf("project %d result/history batch mismatch: records=%+v rename=%q update=%q delete=%q", i, stream.Records, renameBatch, updateBatch, deleteBatch)
		}
	}
	first, err := os.ReadFile(projects[0].r.history.EntityPath("task", "same-id"))
	if err != nil {
		t.Fatal(err)
	}
	second, err := os.ReadFile(projects[1].r.history.EntityPath("task", "same-id"))
	if err != nil {
		t.Fatal(err)
	}
	if string(first) == string(second) {
		t.Fatal("project-local histories unexpectedly share identical state")
	}
}

func TestGenericReconcileIgnoresArchivedTasks(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	path := lifecycleTaskFile(t, root, "archived-only", "archived-only", "Archived")
	archivePath := filepath.Join(root, "archive", "archived-only.md")
	if err := os.MkdirAll(filepath.Dir(archivePath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path, archivePath); err != nil {
		t.Fatal(err)
	}
	r, err := NewFilesystemReconciler(root)
	if err != nil {
		t.Fatal(err)
	}
	if results, err := r.Reconcile(context.Background(), true); err != nil || len(results) != 0 {
		t.Fatalf("generic Reconcile observed archive: results=%+v err=%v", results, err)
	}
	if results, err := r.ReconcileLifecycle(context.Background(), true); err != nil || len(results) != 0 {
		t.Fatalf("generic ReconcileLifecycle observed archive: results=%+v err=%v", results, err)
	}
	if _, err := os.Stat(r.history.EntityPath("task", "archived-only")); !os.IsNotExist(err) {
		t.Fatalf("generic reconciliation created archived history: %v", err)
	}
	if _, err := os.Stat(r.manifestPath()); !os.IsNotExist(err) {
		t.Fatalf("generic reconciliation created archived manifest: %v", err)
	}
}

func TestAuthorizedArchivePurgeRejectsActiveArchiveDuplicate(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	active := lifecycleTaskFile(t, root, "duplicate", "duplicate-id", "Duplicate")
	archive := filepath.Join(root, "archive", "duplicate.md")
	if err := os.MkdirAll(filepath.Dir(archive), 0o755); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(active)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(archive, data, 0o644); err != nil {
		t.Fatal(err)
	}
	task, err := ParseTaskContent(string(data))
	if err != nil {
		t.Fatal(err)
	}
	if err := PurgeTaskLifecycle(context.Background(), root, task.ID, active, CanonicalTaskHash(task), "tester", "privacy", nil); err == nil {
		t.Fatal("authorized purge accepted duplicate active/archive identity")
	}
	if _, err := os.Stat(active); err != nil {
		t.Fatalf("active duplicate was removed: %v", err)
	}
	if _, err := os.Stat(archive); err != nil {
		t.Fatalf("archived duplicate was removed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "history", "tasks", task.ID+".jsonl")); !os.IsNotExist(err) {
		t.Fatalf("duplicate rejection left history: %v", err)
	}
}

func TestLifecycleExactBootstrapDoesNotReconcileUnrelatedMove(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	target := filepath.Join(root, "docs", "target.md")
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("---\nid: exact-doc\ntitle: Target\ntags: []\n---\n\nbody\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	task := lifecycleTaskFile(t, root, "unrelated", "unrelated-task", "Unrelated")
	r, err := NewFilesystemReconciler(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.ReconcileLifecycle(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	moved := filepath.Join(root, "tasks", "unrelated-moved.md")
	if err := os.Rename(task, moved); err != nil {
		t.Fatal(err)
	}
	results, err := r.ReconcileLifecycleBatch(context.Background(), LifecycleBatch{Source: "doc-hard-delete", Limit: 1, ExactEntityType: "doc", ExactEntityID: "exact-doc", ExactPath: "docs/target.md", Hints: []ReconcileHint{{Path: target, Event: "hard_delete"}}}, true)
	if err != nil {
		t.Fatal(err)
	}
	for _, result := range results {
		if result.EntityID == "unrelated-task" && result.Operation != "" {
			t.Fatalf("unrelated move was reconciled: %+v", result)
		}
	}
	stream, err := r.history.Read(context.Background(), "task", "unrelated-task")
	if err != nil || len(stream.Records) != 1 {
		t.Fatalf("unrelated history changed: %+v err=%v", stream.Records, err)
	}
	manifest, err := r.readManifest()
	if err != nil || manifest.Entries[manifestKey("task", "unrelated-task")].Path != "tasks/unrelated.md" {
		t.Fatalf("unrelated manifest changed: %+v err=%v", manifest.Entries[manifestKey("task", "unrelated-task")], err)
	}
}

func TestLifecycleIntentRunsAfterManifestOwnership(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	old := lifecycleTaskFile(t, root, "a", "intent-order", "A")
	var observedPath string
	var r *FilesystemReconciler
	var err error
	r, err = NewFilesystemReconciler(root, func(result ReconcileResult) error {
		manifest, readErr := r.readManifest()
		if readErr != nil {
			return readErr
		}
		observedPath = manifest.Entries[manifestKey(result.EntityType, result.EntityID)].Path
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.ReconcileLifecycle(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	newPath := filepath.Join(root, "tasks", "b.md")
	if err := os.Rename(old, newPath); err != nil {
		t.Fatal(err)
	}
	if _, err := r.ReconcileLifecycle(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if observedPath != "tasks/b.md" {
		t.Fatalf("callback observed path=%q", observedPath)
	}
}

func TestLifecycleDocRenameDeleteRestoreReplaysHash(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	path := filepath.Join(root, "docs", "a.md")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("---\nid: doc-life\ntitle: D\ntags: []\n---\n\nbody\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r, err := NewFilesystemReconciler(root)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	r.SetLifecycleClock(func() time.Time { return now })
	if _, err := r.ReconcileLifecycle(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	newPath := filepath.Join(root, "docs", "b.md")
	if err := os.Rename(path, newPath); err != nil {
		t.Fatal(err)
	}
	if _, err := r.ReconcileLifecycle(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(newPath); err != nil {
		t.Fatal(err)
	}
	if _, err := r.ReconcileLifecycle(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	now = now.Add(ReconcileQuietWindow)
	if _, err := r.ReconcileLifecycle(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Restore(context.Background(), "doc", "doc-life", RestoreOptions{Path: "docs/b.md"}); err != nil {
		t.Fatal(err)
	}
	stream, err := r.history.Read(context.Background(), "doc", "doc-life")
	if err != nil {
		t.Fatal(err)
	}
	if len(stream.Records) != 4 {
		t.Fatalf("doc records=%d", len(stream.Records))
	}
	if _, err := docHistoryFromRecords("docs/b.md", stream.Records); err != nil {
		t.Fatalf("doc replay: %v", err)
	}
}

func TestRestoreRepairsASpuriousTombstoneLeftOverALivingFile(t *testing.T) {
	// A watcher pass that observes a file as briefly missing writes a tombstone
	// for an entity that was never deleted. Reconciliation then reports the
	// entity unchanged forever, because the file hash still matches the
	// tombstone's, so nothing repairs the contradiction on its own.
	root := filepath.Join(t.TempDir(), ".knowns")
	path := lifecycleTaskFile(t, root, "alive", "spurious", "Alive")
	r, err := NewFilesystemReconciler(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.ReconcileLifecycle(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	stream, err := r.history.Read(context.Background(), "task", "spurious")
	if err != nil || len(stream.Records) == 0 {
		t.Fatalf("stream=%+v err=%v", stream.Records, err)
	}
	live := stream.Records[len(stream.Records)-1]

	// Forge the tombstone directly: the file never left, which is exactly the
	// state a spurious deletion leaves behind.
	if err := r.appendHistoryRecord(context.Background(), models.HistoryRecord{
		EntityType: "task", EntityID: "spurious", Source: "watcher-startup", Operation: LifecycleOperationDelete,
		Tombstone: true, Timestamp: time.Now().UTC(), BaseHash: live.NewHash, NewHash: live.NewHash,
		Checkpoint: true, CheckpointPayload: live.CheckpointPayload, CurrentPath: "tasks/alive.md",
	}); err != nil {
		t.Fatal(err)
	}

	// Reconciliation cannot see the problem: the hash still matches.
	results, err := r.ReconcileLifecycle(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}
	for _, res := range results {
		if res.EntityID == "spurious" && res.Changed {
			t.Fatalf("reconciliation unexpectedly repaired the tombstone: %+v", res)
		}
	}

	result, err := r.Restore(context.Background(), "task", "spurious", RestoreOptions{Path: "tasks/alive.md"})
	if err != nil {
		t.Fatalf("spurious tombstone could not be repaired: %v", err)
	}
	if result.Operation != LifecycleOperationRestore || !result.Changed {
		t.Fatalf("restore result = %+v, want a durable restore", result)
	}
	if _, statErr := os.Stat(path); statErr != nil {
		t.Fatalf("restore disturbed the living file: %v", statErr)
	}
	stream, err = r.history.Read(context.Background(), "task", "spurious")
	if err != nil {
		t.Fatal(err)
	}
	head := stream.Records[len(stream.Records)-1]
	if head.Operation != LifecycleOperationRestore || head.Tombstone {
		t.Fatalf("history head still claims deletion: %+v", head)
	}
	if head.NewHash != live.NewHash {
		t.Fatalf("restore changed the canonical hash: %q != %q", head.NewHash, live.NewHash)
	}
}

func TestRestoreStillRefusesAnUnrelatedFileOccupyingThePath(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	lifecycleTaskFile(t, root, "occupied", "occupier", "Original")
	r, err := NewFilesystemReconciler(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.ReconcileLifecycle(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	stream, err := r.history.Read(context.Background(), "task", "occupier")
	if err != nil {
		t.Fatal(err)
	}
	live := stream.Records[len(stream.Records)-1]
	if err := r.appendHistoryRecord(context.Background(), models.HistoryRecord{
		EntityType: "task", EntityID: "occupier", Source: "watcher", Operation: LifecycleOperationDelete,
		Tombstone: true, Timestamp: time.Now().UTC(), BaseHash: live.NewHash, NewHash: live.NewHash,
		Checkpoint: true, CheckpointPayload: live.CheckpointPayload, CurrentPath: "tasks/occupied.md",
	}); err != nil {
		t.Fatal(err)
	}
	// Different content now sits at the path, so it is not this entity's file.
	lifecycleTaskFile(t, root, "occupied", "occupier", "Rewritten By Something Else")
	if _, err := r.Restore(context.Background(), "task", "occupier", RestoreOptions{Path: "tasks/occupied.md"}); !errors.Is(err, ErrReconcileUnsafe) {
		t.Fatalf("restore adopted foreign content at the path: err=%v", err)
	}
}
