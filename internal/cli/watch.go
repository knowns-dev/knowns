package cli

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"

	"github.com/howznguyen/knowns/internal/storage"
)

// StartKnowledgeWatcher observes only canonical Task/Doc Markdown roots. It
// emits coalesced, content-free hints; callers own the serialized
// reconciliation worker and history/index side effects.
func StartKnowledgeWatcher(ctx context.Context, storeRoot string, enqueue func([]storage.ReconcileHint) error) error {
	if enqueue == nil {
		return fmt.Errorf("knowledge watcher enqueue callback is required")
	}
	if absolute, err := filepath.Abs(storeRoot); err == nil {
		storeRoot = absolute
	}
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return fmt.Errorf("create knowledge watcher: %w", err)
	}
	defer watcher.Close()
	for _, root := range []string{filepath.Join(storeRoot, "tasks"), filepath.Join(storeRoot, "docs")} {
		if !knowledgeDirectoryAllowed(storeRoot, root) {
			continue
		}
		if err := addKnowledgeDirsWithin(watcher, storeRoot, root); err != nil {
			return err
		}
	}
	var enqueueErr error
	scheduler := storage.NewReconcileScheduler(func(batch []storage.ReconcileHint) {
		if err := enqueue(batch); err != nil {
			enqueueErr = err
		}
	}, nil)
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
			if event.Has(fsnotify.Create) {
				// A create event can describe a file, symlink, or path outside the
				// canonical roots. Prove a real in-root directory with Lstat before
				// issuing any watcher.Add call.
				if knowledgeDirectoryAllowed(storeRoot, event.Name) {
					if addErr := addKnowledgeDirsWithin(watcher, storeRoot, event.Name); addErr != nil {
						return addErr
					}
					continue
				}
			}
			if !isKnowledgeEvent(event, storeRoot) {
				continue
			}
			rel, err := filepath.Rel(storeRoot, event.Name)
			if err != nil || rel == "" || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
				continue
			}
			scheduler.Offer(event.Name, "", event.Name)
		case <-ticker.C:
			scheduler.Tick()
			if enqueueErr != nil {
				return enqueueErr
			}
		case err, ok := <-watcher.Errors:
			if ok {
				fmt.Fprintf(os.Stderr, "knowledge watcher error: %v\n", err)
			}
		}
	}
}

func addKnowledgeDirsWithin(watcher *fsnotify.Watcher, storeRoot, root string) error {
	return walkKnowledgeDirs(storeRoot, root, watcher.Add)
}

func walkKnowledgeDirs(storeRoot, root string, add func(string) error) error {
	if !knowledgeDirectoryAllowed(storeRoot, root) {
		return nil
	}
	return filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, statErr := os.Lstat(path)
		if statErr != nil {
			if os.IsNotExist(statErr) {
				return nil
			}
			return statErr
		}
		if info.Mode()&os.ModeSymlink != 0 {
			// WalkDir does not follow symlinks, but explicitly prune a symlink
			// whose target is a directory. Symlinked files are ordinary leaves.
			if target, targetErr := os.Stat(path); targetErr == nil && target.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if !info.IsDir() {
			// Files must never prune sibling directories in lexical WalkDir
			// order. Only real directories reach the watcher.Add boundary.
			return nil
		}
		if !knowledgeDirectoryAllowed(storeRoot, path) {
			return filepath.SkipDir
		}
		if err := add(path); err != nil {
			return err
		}
		return nil
	})
}

func knowledgeDirectoryAllowed(storeRoot, candidate string) bool {
	root, err := filepath.Abs(storeRoot)
	if err != nil {
		return false
	}
	path, err := filepath.Abs(candidate)
	if err != nil {
		return false
	}
	canonicalRoot := ""
	for _, name := range []string{"tasks", "docs"} {
		candidateRoot := filepath.Join(root, name)
		if underKnowledgeRoot(candidateRoot, path) {
			canonicalRoot = candidateRoot
			break
		}
	}
	if canonicalRoot == "" {
		return false
	}
	for current := path; ; current = filepath.Dir(current) {
		info, statErr := os.Lstat(current)
		if statErr != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return false
		}
		if filepath.Clean(current) == filepath.Clean(canonicalRoot) {
			return true
		}
		parent := filepath.Dir(current)
		if parent == current || !underKnowledgeRoot(canonicalRoot, parent) {
			return false
		}
	}
}

func isKnowledgeEvent(event fsnotify.Event, storeRoot string) bool {
	if !event.Has(fsnotify.Write) && !event.Has(fsnotify.Create) && !event.Has(fsnotify.Remove) && !event.Has(fsnotify.Rename) {
		return false
	}
	path, err := filepath.Abs(event.Name)
	if err != nil {
		return false
	}
	if !underKnowledgeRoot(filepath.Join(storeRoot, "tasks"), path) && !underKnowledgeRoot(filepath.Join(storeRoot, "docs"), path) {
		return false
	}
	base := filepath.Base(path)
	if strings.HasPrefix(base, ".") || strings.HasSuffix(base, ".tmp") || strings.HasSuffix(base, "~") || !strings.EqualFold(filepath.Ext(base), ".md") {
		return false
	}
	// Symlink and stability validation belongs to the resolver worker; the
	// fsnotify loop remains a metadata-free hint producer.
	return true
}

func underKnowledgeRoot(root, path string) bool {
	rel, err := filepath.Rel(filepath.Clean(root), filepath.Clean(path))
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
