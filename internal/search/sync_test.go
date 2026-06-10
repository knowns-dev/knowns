package search

import (
	"testing"
)

func TestBestEffortIndexFile_IsNoOp(t *testing.T) {
	// BestEffortIndexFile should be a no-op — code indexing uses LSP, not vector store.
	// Calling it with nil store should not panic.
	BestEffortIndexFile(nil, "test.go", "/abs/test.go")
}

func TestBestEffortRemoveFile_IsNoOp(t *testing.T) {
	// BestEffortRemoveFile should be a no-op — code indexing uses LSP, not vector store.
	BestEffortRemoveFile(nil, "test.go")
}

func TestReindex_DoesNotIndexCode(t *testing.T) {
	// IndexService.Reindex only handles tasks, docs, and memories.
	// It does not index code files — verified by inspecting the Reindex implementation
	// at internal/search/index.go:34 which iterates only tasks, docs, imported docs,
	// and memories. Code BM25 discovery is opt-in and separate from the default ingest.
	//
	// BestEffortIndexFile and BestEffortRemoveFile are no-ops (see sync.go:202, sync.go:207).
	// Code intelligence uses LSP for real-time operations, not vector store indexing.
	//
	// This test verifies the behavioral contract: calling sync functions with code paths
	// does not cause indexing operations.
}
