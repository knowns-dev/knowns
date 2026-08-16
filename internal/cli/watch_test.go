package cli

import (
	"os"
	"path/filepath"
	"testing"
)

func TestKnowledgeDirectoryAllowedRequiresRealInRootDirectory(t *testing.T) {
	storeRoot := filepath.Join(t.TempDir(), ".knowns")
	tasksRoot := filepath.Join(storeRoot, "tasks")
	if err := os.MkdirAll(filepath.Join(tasksRoot, "nested"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tasksRoot, "new.txt"), []byte("temp"), 0o644); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(tasksRoot, "outside-link")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if !knowledgeDirectoryAllowed(storeRoot, filepath.Join(tasksRoot, "nested")) {
		t.Fatal("valid nested directory was rejected")
	}
	if knowledgeDirectoryAllowed(storeRoot, filepath.Join(tasksRoot, "new.txt")) {
		t.Fatal("created non-directory was accepted")
	}
	if knowledgeDirectoryAllowed(storeRoot, filepath.Join(tasksRoot, "outside-link")) {
		t.Fatal("symlink directory was accepted")
	}
	if knowledgeDirectoryAllowed(storeRoot, filepath.Join(outside, "nested")) {
		t.Fatal("outside directory was accepted")
	}
}

func TestWalkKnowledgeDirsDoesNotPruneSiblingsAfterRegularFile(t *testing.T) {
	storeRoot := filepath.Join(t.TempDir(), ".knowns")
	docsRoot := filepath.Join(storeRoot, "docs")
	nested := filepath.Join(docsRoot, "z", "deep")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(docsRoot, "a.md"), []byte("doc"), 0o644); err != nil {
		t.Fatal(err)
	}
	var added []string
	if err := walkKnowledgeDirs(storeRoot, docsRoot, func(path string) error {
		added = append(added, path)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{docsRoot: true, filepath.Join(docsRoot, "z"): true, nested: true}
	for path := range want {
		found := false
		for _, got := range added {
			if got == path {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("directory %q was not registered; added=%v", path, added)
		}
	}
	for _, path := range added {
		if path == filepath.Join(docsRoot, "a.md") {
			t.Fatal("regular file was registered as a directory")
		}
	}
}
