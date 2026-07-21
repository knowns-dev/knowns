package lsp

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

func acquireLanguageInstallLock(ctx context.Context, baseDir, languageID string) (func(), bool, error) {
	lockDir := filepath.Join(baseDir, ".locks")
	if err := os.MkdirAll(lockDir, 0o755); err != nil {
		return nil, false, fmt.Errorf("create install lock directory: %w", err)
	}
	digest := sha256.Sum256([]byte(languageID))
	path := filepath.Join(lockDir, fmt.Sprintf("%x.lock", digest[:]))
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, false, fmt.Errorf("open install lock: %w", err)
	}
	waited, err := lockFileContext(ctx, file)
	if err != nil {
		_ = file.Close()
		return nil, waited, fmt.Errorf("lock install for %s: %w", languageID, err)
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			_ = unlockFile(file)
			_ = file.Close()
		})
	}, waited, nil
}
