package cli

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"

	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
)

const watchDebounceMs = 1500

// watchDirs recursively adds directories to the watcher.
func watchDirs(watcher *fsnotify.Watcher, dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() && !strings.HasPrefix(entry.Name(), ".") && entry.Name() != "node_modules" && entry.Name() != "__pycache__" {
			path := filepath.Join(dir, entry.Name())
			if err := watcher.Add(path); err != nil {
				// Skip dirs we can't watch
				continue
			}
			if err := watchDirs(watcher, path); err != nil {
				continue
			}
		}
	}
	return nil
}

func isWatchedCodeEvent(event fsnotify.Event) bool {
	if !event.Has(fsnotify.Write) && !event.Has(fsnotify.Create) && !event.Has(fsnotify.Remove) && !event.Has(fsnotify.Rename) {
		return false
	}
	rel := filepath.Base(event.Name)
	if strings.HasPrefix(rel, ".") || rel == "node_modules" || rel == "__pycache__" {
		return false
	}
	ext := strings.ToLower(filepath.Ext(event.Name))
	switch ext {
	case ".go", ".ts", ".tsx", ".js", ".jsx", ".py":
		return true
	}
	return false
}

func handleWatchEvent(store *storage.Store, projectRoot, relPath string, removed bool) {
	absPath := filepath.Join(projectRoot, relPath)
	if removed {
		search.BestEffortRemoveFile(store, relPath)
		fmt.Printf("  [removed] %s\n", relPath)
	} else {
		search.BestEffortIndexFile(store, relPath, absPath)
		fmt.Printf("  [indexed] %s\n", relPath)
	}
}

// StartCodeWatcher starts a file watcher for code files in projectRoot.
// It runs until ctx is cancelled. Debounce defaults to 1500ms.
func StartCodeWatcher(ctx context.Context, store *storage.Store, projectRoot string, debounceMs int) error {
	debounce := time.Duration(debounceMs) * time.Millisecond

	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return fmt.Errorf("create watcher: %w", err)
	}
	defer watcher.Close()

	// Watch all subdirectories
	watchDirs(watcher, projectRoot)

	type pendingEvent struct {
		path    string
		removed bool
		at      time.Time
	}
	var pendingMu sync.Mutex
	pending := make(map[string]pendingEvent)

	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return nil
		case event, ok := <-watcher.Events:
			if !ok {
				return nil
			}
			if !isWatchedCodeEvent(event) {
				continue
			}
			rel, _ := filepath.Rel(projectRoot, event.Name)
			if rel != "" && !strings.HasPrefix(rel, "..") {
				pendingMu.Lock()
				if event.Has(fsnotify.Remove) {
					pending[rel] = pendingEvent{path: rel, removed: true, at: time.Now()}
				} else {
					pending[rel] = pendingEvent{path: rel, removed: false, at: time.Now()}
				}
				pendingMu.Unlock()
			}
		case <-ticker.C:
			pendingMu.Lock()
			now := time.Now()
			for path, pe := range pending {
				if now.Sub(pe.at) >= debounce {
					delete(pending, path)
					go func(p string, removed bool) {
						handleWatchEvent(store, projectRoot, p, removed)
					}(path, pe.removed)
				}
			}
			pendingMu.Unlock()
		case err, ok := <-watcher.Errors:
			if !ok {
				return nil
			}
			fmt.Fprintf(os.Stderr, "watcher error: %v\n", err)
		}
	}
}
