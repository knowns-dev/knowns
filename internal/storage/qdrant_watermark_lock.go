package storage

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

var qdrantWatermarkLocks sync.Map // canonical root -> *sync.Mutex

// WithQdrantWatermarkLock serializes watermark read-modify-write operations
// within and across processes. The lock lives under ignored runtime state.
func WithQdrantWatermarkLock(ctx context.Context, root string, fn func() error) error {
	if ctx == nil {
		ctx = context.Background()
	}
	key, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	value, _ := qdrantWatermarkLocks.LoadOrStore(filepath.Clean(key), &sync.Mutex{})
	mu := value.(*sync.Mutex)
	mu.Lock()
	defer mu.Unlock()
	dir := filepath.Join(root, ".search", "locks")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("qdrant watermark lock: create directory: %w", err)
	}
	file, err := os.OpenFile(filepath.Join(dir, "qdrant-watermarks.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return fmt.Errorf("qdrant watermark lock: open: %w", err)
	}
	defer file.Close()
	if err := lockTaskLifecycleFile(ctx, file); err != nil {
		return fmt.Errorf("qdrant watermark lock: acquire: %w", err)
	}
	defer unlockTaskLifecycleFile(file)
	return fn()
}
