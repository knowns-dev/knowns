package storage

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
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
