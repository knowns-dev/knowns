//go:build darwin || linux

package lsp

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestRegistryShebangDoesNotBlockOnFIFOOrSymlinkToFIFO(t *testing.T) {
	root := t.TempDir()
	fifo := filepath.Join(root, "script-pipe")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	symlink := filepath.Join(root, "linked-pipe")
	if err := os.Symlink(fifo, symlink); err != nil {
		t.Fatal(err)
	}
	registry := NewRegistry([]Language{{
		ID:   "bash",
		Name: "Bash",
		Matchers: []PathMatcher{{
			Kind:     PathMatcherShebang,
			Pattern:  "bash",
			Priority: 100,
		}},
	}})

	for _, path := range []string{fifo, symlink} {
		path := path
		t.Run(filepath.Base(path), func(t *testing.T) {
			result := make(chan bool, 1)
			go func() {
				_, ok := registry.ForPath(path)
				result <- ok
			}()
			select {
			case ok := <-result:
				if ok {
					t.Fatalf("ForPath(%q) routed a FIFO", path)
				}
			case <-time.After(time.Second):
				t.Fatalf("ForPath(%q) blocked while inspecting a FIFO", path)
			}
		})
	}
}
