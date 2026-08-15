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

func TestTaskLifecycleLockUsesIgnoredSearchRuntimeDirectory(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	store := NewStore(root)
	if err := store.Init("lock-location"); err != nil {
		t.Fatalf("Init: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, ".search", "locks", "tasks.lock")); err != nil {
		t.Fatalf("runtime lock missing from .search: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, ".locks")); !os.IsNotExist(err) {
		t.Fatalf("unexpected tracked-root lock directory: %v", err)
	}
}

func TestTaskLifecycleTransactionSerializesStoresAndHonorsContext(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	storeA := NewStore(root)
	if err := storeA.Init("cross-store-lock"); err != nil {
		t.Fatalf("Init: %v", err)
	}
	storeB := NewStore(root)

	locked := make(chan struct{})
	release := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- storeA.WithTaskLifecycleTransaction(context.Background(), func(*TaskLifecycleTransaction) error {
			close(locked)
			<-release
			return nil
		})
	}()
	<-locked

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	err := storeB.WithTaskLifecycleTransaction(ctx, func(*TaskLifecycleTransaction) error {
		t.Fatal("second transaction acquired a held project lock")
		return nil
	})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("second transaction error = %v, want deadline exceeded", err)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatalf("first transaction: %v", err)
	}
}

func TestTaskLifecycleVersionUsesDeltaAfterInitialCheckpoint(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("lifecycle-history"); err != nil {
		t.Fatalf("Init: %v", err)
	}
	oldTask := &models.Task{ID: "delta-task", Title: "Task", Status: "todo", Priority: "medium"}
	newTask := *oldTask
	newTask.Status = "done"
	if err := store.WithTaskLifecycleTransaction(context.Background(), func(tx *TaskLifecycleTransaction) error {
		return tx.SaveTaskVersion(nil, oldTask, "tester", time.Now().UTC(), "first")
	}); err != nil {
		t.Fatalf("save initial lifecycle version: %v", err)
	}
	if err := store.WithTaskLifecycleTransaction(context.Background(), func(tx *TaskLifecycleTransaction) error {
		return tx.SaveTaskVersion(oldTask, &newTask, "tester", time.Now().UTC(), "second")
	}); err != nil {
		t.Fatalf("save delta lifecycle version: %v", err)
	}
	history, err := store.Versions.GetHistory(oldTask.ID)
	if err != nil || len(history.Versions) != 2 {
		t.Fatalf("history = %#v err=%v", history, err)
	}
	if !history.Versions[0].Checkpoint || history.Versions[1].Checkpoint {
		t.Fatalf("checkpoint policy = first %v second %v, want checkpoint then delta", history.Versions[0].Checkpoint, history.Versions[1].Checkpoint)
	}
}
