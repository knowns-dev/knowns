package storage

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
)

// taskLifecycleLock combines an in-process semaphore with an OS-level file
// lock. The file lock is required because CLI, MCP, and the server can mutate
// the same project through independent Store instances.
type taskLifecycleLock struct {
	root  string
	token chan struct{}
}

func newTaskLifecycleLock(root string) *taskLifecycleLock {
	lock := &taskLifecycleLock{root: root, token: make(chan struct{}, 1)}
	lock.token <- struct{}{}
	return lock
}

func (lock *taskLifecycleLock) with(ctx context.Context, fn func() error) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-lock.token:
	}
	defer func() { lock.token <- struct{}{} }()
	if err := ctx.Err(); err != nil {
		return err
	}

	// .search is an existing ignored runtime directory in every git tracking
	// mode, so the lock can never leak into a project's tracked knowledge.
	lockDir := filepath.Join(lock.root, ".search", "locks")
	if err := os.MkdirAll(lockDir, 0o755); err != nil {
		return fmt.Errorf("task lifecycle lock: create directory: %w", err)
	}
	file, err := os.OpenFile(filepath.Join(lockDir, "tasks.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return fmt.Errorf("task lifecycle lock: open: %w", err)
	}
	defer file.Close()

	if err := lockTaskLifecycleFile(ctx, file); err != nil {
		return fmt.Errorf("task lifecycle lock: acquire: %w", err)
	}
	defer unlockTaskLifecycleFile(file)
	return fn()
}
