package cli

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

func runReconcileRestore(t *testing.T, args ...string) (string, error) {
	t.Helper()
	t.Cleanup(func() {
		reconcileRestoreExecute = false
		_ = reconcileRestoreCmd.Flags().Set("execute", "false")
		rootCmd.SetArgs(nil)
	})
	var callErr error
	rootCmd.SetArgs(append([]string{"reconcile", "restore"}, args...))
	output := captureStdout(t, func() { callErr = rootCmd.ExecuteContext(context.Background()) })
	reconcileRestoreExecute = false
	_ = reconcileRestoreCmd.Flags().Set("execute", "false")
	return output, callErr
}

func TestReconcileRestorePreviewsThenReactivatesADeletedTask(t *testing.T) {
	projectRoot := t.TempDir()
	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	if err := store.Init("cli-restore"); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := store.Tasks.Create(&models.Task{ID: "gone", Title: "Gone", Status: "todo", Priority: "medium", CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	files, _ := filepath.Glob(filepath.Join(store.Root, "tasks", "*.md"))
	if len(files) != 1 {
		t.Fatalf("task files = %v", files)
	}
	r, err := storage.NewFilesystemReconciler(store.Root)
	if err != nil {
		t.Fatal(err)
	}
	clock := now
	r.SetLifecycleClock(func() time.Time { return clock })
	ctx := context.Background()
	if _, err := r.ReconcileLifecycle(ctx, true); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(files[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := r.ReconcileLifecycle(ctx, true); err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(storage.ReconcileQuietWindow)
	if _, err := r.ReconcileLifecycle(ctx, true); err != nil {
		t.Fatal(err)
	}

	origDir, _ := os.Getwd()
	if err := os.Chdir(projectRoot); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(origDir) })

	preview, err := runReconcileRestore(t, "task", "gone")
	if err != nil || !strings.Contains(preview, "would-restore type=task id=gone") || !strings.Contains(preview, "file-present=false") {
		t.Fatalf("preview = %q err=%v", preview, err)
	}
	if _, statErr := os.Stat(files[0]); !os.IsNotExist(statErr) {
		t.Fatalf("preview recreated the file: %v", statErr)
	}
	restored, err := runReconcileRestore(t, "task", "gone", "--execute")
	if err != nil || !strings.Contains(restored, "restored type=task id=gone") {
		t.Fatalf("execute = %q err=%v", restored, err)
	}
	if _, statErr := os.Stat(files[0]); statErr != nil {
		t.Fatalf("restore did not bring the file back: %v", statErr)
	}
	if _, err := runReconcileRestore(t, "task", "gone", "--execute"); err == nil {
		t.Fatal("restoring a live Task with --execute must fail")
	}
	if _, err := runReconcileRestore(t, "memory", "gone"); err == nil {
		t.Fatal("an unknown entity type must fail")
	}
}
