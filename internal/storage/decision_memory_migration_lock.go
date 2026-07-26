package storage

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
)

type decisionMemoryMigrationLock struct {
	root  string
	token chan struct{}
}

func newDecisionMemoryMigrationLock(root string) *decisionMemoryMigrationLock {
	lock := &decisionMemoryMigrationLock{root: root, token: make(chan struct{}, 1)}
	lock.token <- struct{}{}
	return lock
}

func (lock *decisionMemoryMigrationLock) with(ctx context.Context, fn func() error) error {
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-lock.token:
	}
	defer func() { lock.token <- struct{}{} }()

	lockDir := filepath.Join(lock.root, ".search", "locks")
	if err := os.MkdirAll(lockDir, 0o755); err != nil {
		return fmt.Errorf("decision memory migration lock: create directory: %w", err)
	}
	file, err := os.OpenFile(filepath.Join(lockDir, "decision-memory-migration.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return fmt.Errorf("decision memory migration lock: open: %w", err)
	}
	defer file.Close()
	if err := lockTaskLifecycleFile(ctx, file); err != nil {
		return fmt.Errorf("decision memory migration lock: acquire: %w", err)
	}
	defer unlockTaskLifecycleFile(file)
	return fn()
}
