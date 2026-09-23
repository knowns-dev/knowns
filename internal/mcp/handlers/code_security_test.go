package handlers

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFindCodeFiles_RejectsPathTraversal(t *testing.T) {
	tmpDir := t.TempDir()
	root := filepath.Join(tmpDir, "project")
	outside := filepath.Join(tmpDir, "outside")
	os.MkdirAll(root, 0755)
	os.MkdirAll(outside, 0755)

	// Relative traversal
	_, err := findCodeFiles(root, "../../outside")
	if err == nil {
		t.Fatal("expected error on relative path traversal in findCodeFiles, got nil")
	}

	// Absolute outside path
	_, err = findCodeFiles(root, outside)
	if err == nil {
		t.Fatal("expected error on absolute outside path in findCodeFiles, got nil")
	}

	// Valid subpath inside project
	subDir := filepath.Join(root, "src")
	os.MkdirAll(subDir, 0755)
	testFile := filepath.Join(subDir, "main.go")
	os.WriteFile(testFile, []byte("package main"), 0644)

	files, err := findCodeFiles(root, "src")
	if err != nil {
		t.Fatalf("unexpected error on valid subpath: %v", err)
	}
	if len(files) == 0 {
		t.Fatal("expected to find main.go in src directory")
	}
}
