package search

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func unitVec(dims, hot int) []float32 {
	v := make([]float32, dims)
	v[hot] = 1
	return v
}

// TestSQLiteSearchReturnsTheMemoryID is the defect that cost every global
// memory its semantic layer. The store persisted memory_layer and
// memory_store but never memory_id, so a memory hit came back from Search with
// an empty ID; the engine keys memory results by it and the runtime hook drops
// any result without one. Nothing errored anywhere.
func TestSQLiteSearchReturnsTheMemoryID(t *testing.T) {
	dir := filepath.Join(t.TempDir(), ".search")
	const dims = 8
	store := NewSQLiteVectorStore(dir, "test-model", dims)
	if err := store.Load(); err != nil {
		t.Fatalf("load: %v", err)
	}
	store.AddChunks([]Chunk{{
		ID: "memory:ipkq69:chunk:content", Type: ChunkTypeMemory, Content: "no em dash",
		MemoryID: "ipkq69", MemoryLayer: "global", MemoryStore: "global-store",
		Embedding: unitVec(dims, 0),
	}, {
		ID: "decision:d1:chunk:0", Type: ChunkTypeDecision, Content: "decision body",
		DecisionID: "d1", Embedding: unitVec(dims, 1),
	}})

	assertIDs := func(label string, s *SQLiteVectorStore) {
		t.Helper()
		mem := s.Search(unitVec(dims, 0), VectorSearchOpts{TopK: 5, ChunkType: ChunkTypeMemory})
		if len(mem) == 0 || mem[0].MemoryID != "ipkq69" {
			t.Fatalf("%s: memory hit = %+v, want MemoryID ipkq69", label, mem)
		}
		// Decisions went through the same two lines and lost DecisionID the
		// same way.
		dec := s.Search(unitVec(dims, 1), VectorSearchOpts{TopK: 5, ChunkType: ChunkTypeDecision})
		if len(dec) == 0 || dec[0].DecisionID != "d1" {
			t.Fatalf("%s: decision hit = %+v, want DecisionID d1", label, dec)
		}
	}
	assertIDs("in memory", store)

	// And across a save and reload, which is the path the global index takes
	// on every new process.
	if err := store.Save(); err != nil {
		t.Fatalf("save: %v", err)
	}
	_ = store.Close()
	reopened := NewSQLiteVectorStore(dir, "test-model", dims)
	if err := reopened.Load(); err != nil {
		t.Fatalf("reload: %v", err)
	}
	defer reopened.Close()
	assertIDs("after reload", reopened)
}

// TestSQLiteBackfillsMemoryIDOnAnIndexWrittenBeforeTheColumn covers the index
// already on disk. It has no memory_id column at all; opening it must add the
// column and fill it from the chunk id, so an existing install is fixed without
// a reindex.
func TestSQLiteBackfillsMemoryIDOnAnIndexWrittenBeforeTheColumn(t *testing.T) {
	dir := filepath.Join(t.TempDir(), ".search")
	const dims = 8
	seed := NewSQLiteVectorStore(dir, "test-model", dims)
	if err := seed.Load(); err != nil {
		t.Fatalf("load: %v", err)
	}
	seed.AddChunks([]Chunk{{
		ID: "memory:rtsx9j:chunk:content", Type: ChunkTypeMemory, Content: "use tavily",
		MemoryID: "rtsx9j", MemoryLayer: "global", MemoryStore: "global-store",
		Embedding: unitVec(dims, 2),
	}, {
		ID: "doc:readme:chunk:0", Type: ChunkTypeDoc, Content: "readme",
		DocPath: "readme", Embedding: unitVec(dims, 3),
	}})
	if err := seed.Save(); err != nil {
		t.Fatalf("save: %v", err)
	}
	_ = seed.Close()

	// Reproduce the legacy on-disk shape: the column does not exist.
	db, err := sql.Open("sqlite", filepath.Join(dir, "index.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := db.Exec(`ALTER TABLE chunks DROP COLUMN memory_id`); err != nil {
		t.Fatalf("drop column to simulate a legacy index: %v", err)
	}
	_ = db.Close()

	reopened := NewSQLiteVectorStore(dir, "test-model", dims)
	if err := reopened.Load(); err != nil {
		t.Fatalf("reopen legacy index: %v", err)
	}
	defer reopened.Close()
	hits := reopened.Search(unitVec(dims, 2), VectorSearchOpts{TopK: 5, ChunkType: ChunkTypeMemory})
	if len(hits) == 0 || hits[0].MemoryID != "rtsx9j" {
		t.Fatalf("backfilled hit = %+v, want MemoryID rtsx9j", hits)
	}

	// Only memory rows are touched; a doc row must not grow a memory ID.
	check, err := sql.Open("sqlite", filepath.Join(dir, "index.db"))
	if err != nil {
		t.Fatalf("open check: %v", err)
	}
	defer check.Close()
	var docMemoryID sql.NullString
	if err := check.QueryRow(`SELECT memory_id FROM chunks WHERE id = 'doc:readme:chunk:0'`).Scan(&docMemoryID); err != nil {
		t.Fatalf("read doc row: %v", err)
	}
	if docMemoryID.Valid && docMemoryID.String != "" {
		t.Fatalf("backfill touched a doc row: memory_id = %q", docMemoryID.String)
	}
}
