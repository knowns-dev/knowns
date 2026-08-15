package storage

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// memoryMutationLock serializes mutations to one memory across Store
// instances and processes. Memory files do not have history streams of their
// own, so this lock lives beside the project's ignored search locks rather
// than in the history tree.
type memoryMutationLock struct {
	root string
}

var memoryLockMu sync.Map // absolute lock path -> *sync.Mutex

func newMemoryMutationLock(root string) *memoryMutationLock {
	return &memoryMutationLock{root: root}
}

func (lock *memoryMutationLock) with(ctx context.Context, id string, fn func() error) error {
	if lock == nil || fn == nil {
		return fmt.Errorf("memory mutation lock is unavailable")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	path := filepath.Join(lock.root, ".search", "locks", "memories", safeHistoryID(id)+".lock")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("memory mutation lock directory: %w", err)
	}
	muAny, _ := memoryLockMu.LoadOrStore(path, &sync.Mutex{})
	mu := muAny.(*sync.Mutex)
	for !mu.TryLock() {
		timer := time.NewTimer(2 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
	defer mu.Unlock()
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return fmt.Errorf("open memory mutation lock: %w", err)
	}
	defer file.Close()
	if err := lockTaskLifecycleFile(ctx, file); err != nil {
		return fmt.Errorf("acquire memory mutation lock: %w", err)
	}
	defer unlockTaskLifecycleFile(file)
	return fn()
}

func (ms *MemoryStore) withMemoryLock(ctx context.Context, id string, fn func() error) error {
	if ms == nil {
		return fn()
	}
	mutationLock := ms.mutationLock
	if mutationLock == nil {
		root := ms.globalRoot
		if root == "" {
			root = ms.root
		}
		mutationLock = newMemoryMutationLock(root)
	}
	return mutationLock.with(ctx, id, fn)
}

func (ms *MemoryStore) withMemoryLocks(ctx context.Context, ids []string, fn func() error) error {
	ordered := append([]string(nil), ids...)
	sort.Strings(ordered)
	unique := ordered[:0]
	for _, id := range ordered {
		if id != "" && (len(unique) == 0 || unique[len(unique)-1] != id) {
			unique = append(unique, id)
		}
	}
	var acquire func(int) error
	acquire = func(index int) error {
		if index == len(unique) {
			return fn()
		}
		return ms.withMemoryLock(ctx, unique[index], func() error { return acquire(index + 1) })
	}
	return acquire(0)
}
