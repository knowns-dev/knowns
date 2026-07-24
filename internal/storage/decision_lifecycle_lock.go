package storage

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
)

// decisionLifecycleLock serializes multi-file Decision transitions across CLI,
// MCP, and server processes sharing the same project.
type decisionLifecycleLock struct {
	root  string
	token chan struct{}
}

func newDecisionLifecycleLock(root string) *decisionLifecycleLock {
	lock := &decisionLifecycleLock{root: root, token: make(chan struct{}, 1)}
	lock.token <- struct{}{}
	return lock
}

func (lock *decisionLifecycleLock) with(ctx context.Context, fn func() error) error {
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
		return fmt.Errorf("decision lifecycle lock: create directory: %w", err)
	}
	file, err := os.OpenFile(filepath.Join(lockDir, "decisions.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return fmt.Errorf("decision lifecycle lock: open: %w", err)
	}
	defer file.Close()
	if err := lockTaskLifecycleFile(ctx, file); err != nil {
		return fmt.Errorf("decision lifecycle lock: acquire: %w", err)
	}
	defer unlockTaskLifecycleFile(file)
	return fn()
}
