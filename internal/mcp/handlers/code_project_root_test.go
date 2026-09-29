package handlers

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/howznguyen/knowns/internal/safepath"
	"github.com/howznguyen/knowns/internal/storage"
)

// A store-linked project keeps knowledge outside the code repository. Code
// intelligence must resolve files against the repository only.
func TestCodePathsResolveAgainstProjectRootNotKnowledgeRoot(t *testing.T) {
	base := t.TempDir()
	project := filepath.Join(base, "shop-web")
	knowledge := filepath.Join(base, "stores", "team", "shop-web")
	for _, dir := range []string{project, knowledge} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(project, "main.go"), []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(knowledge, "only-in-store.go"), []byte("package x\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	store := storage.NewStoreWithProjectRoot(knowledge, project)
	if got := projectRoot(store); got != project {
		t.Fatalf("projectRoot() = %q, want %q", got, project)
	}

	abs, err := safepath.ResolveProject(projectRoot(store), "main.go")
	if err != nil {
		t.Fatalf("file in the code repository must resolve: %v", err)
	}
	if _, err := os.Stat(abs); err != nil {
		t.Fatalf("resolved path %q does not exist: %v", abs, err)
	}

	if abs, err := safepath.ResolveProject(projectRoot(store), "only-in-store.go"); err == nil {
		if _, statErr := os.Stat(abs); statErr == nil {
			t.Fatalf("a file that exists only in the store must not be reachable as a project file, resolved %q", abs)
		}
	}
}
