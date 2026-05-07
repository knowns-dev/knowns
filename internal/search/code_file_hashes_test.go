package search

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

func setupTestDB(t *testing.T) *sql.DB {
	t.Helper()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })

	// Create schema.
	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS code_file_hashes (
			file_path    TEXT PRIMARY KEY,
			file_hash    TEXT NOT NULL,
			chunk_hashes TEXT NOT NULL DEFAULT '{}',
			updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`)
	if err != nil {
		t.Fatal(err)
	}
	return db
}

func TestLoadSaveCodeFileHashes(t *testing.T) {
	db := setupTestDB(t)

	// Initially empty.
	hashes, err := LoadCodeFileHashes(db)
	if err != nil {
		t.Fatal(err)
	}
	if len(hashes) != 0 {
		t.Fatalf("expected 0 hashes, got %d", len(hashes))
	}

	// Save some hashes.
	input := map[string]CodeFileHash{
		"src/main.go": {
			FilePath: "src/main.go",
			FileHash: "abc123",
			ChunkHashes: map[string]string{
				"code::src/main.go::main":    "hash1",
				"code::src/main.go::__file__": "hash2",
			},
		},
		"src/util.go": {
			FilePath: "src/util.go",
			FileHash: "def456",
			ChunkHashes: map[string]string{
				"code::src/util.go::helper": "hash3",
			},
		},
	}

	if err := SaveCodeFileHashes(db, input); err != nil {
		t.Fatal(err)
	}

	// Load back.
	loaded, err := LoadCodeFileHashes(db)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded) != 2 {
		t.Fatalf("expected 2 hashes, got %d", len(loaded))
	}

	mainHash := loaded["src/main.go"]
	if mainHash.FileHash != "abc123" {
		t.Errorf("expected file hash abc123, got %s", mainHash.FileHash)
	}
	if len(mainHash.ChunkHashes) != 2 {
		t.Errorf("expected 2 chunk hashes, got %d", len(mainHash.ChunkHashes))
	}
	if mainHash.ChunkHashes["code::src/main.go::main"] != "hash1" {
		t.Errorf("unexpected chunk hash: %s", mainHash.ChunkHashes["code::src/main.go::main"])
	}
}

func TestHashFileContent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.txt")
	os.WriteFile(path, []byte("hello world"), 0644)

	hash1, err := HashFileContent(path)
	if err != nil {
		t.Fatal(err)
	}
	if hash1 == "" {
		t.Fatal("expected non-empty hash")
	}

	// Same content = same hash.
	hash2, err := HashFileContent(path)
	if err != nil {
		t.Fatal(err)
	}
	if hash1 != hash2 {
		t.Errorf("expected same hash, got %s vs %s", hash1, hash2)
	}

	// Different content = different hash.
	os.WriteFile(path, []byte("hello world!"), 0644)
	hash3, err := HashFileContent(path)
	if err != nil {
		t.Fatal(err)
	}
	if hash1 == hash3 {
		t.Error("expected different hash for different content")
	}
}

func TestHashString(t *testing.T) {
	h1 := HashString("hello")
	h2 := HashString("hello")
	h3 := HashString("world")

	if h1 != h2 {
		t.Error("same input should produce same hash")
	}
	if h1 == h3 {
		t.Error("different input should produce different hash")
	}
	if h1 == "" {
		t.Error("hash should not be empty")
	}
}

func TestComputeFileDelta(t *testing.T) {
	dir := t.TempDir()

	// Create test files.
	os.WriteFile(filepath.Join(dir, "unchanged.go"), []byte("package main"), 0644)
	os.WriteFile(filepath.Join(dir, "changed.go"), []byte("package changed"), 0644)
	os.WriteFile(filepath.Join(dir, "new.go"), []byte("package new"), 0644)

	// Build cached hashes (simulating previous ingest).
	unchangedHash, _ := HashFileContent(filepath.Join(dir, "unchanged.go"))
	cached := map[string]CodeFileHash{
		"unchanged.go": {
			FilePath: "unchanged.go",
			FileHash: unchangedHash,
			ChunkHashes: map[string]string{
				"code::unchanged.go::__file__": "h1",
			},
		},
		"changed.go": {
			FilePath: "changed.go",
			FileHash: "old_hash_different",
			ChunkHashes: map[string]string{
				"code::changed.go::__file__": "h2",
			},
		},
		"deleted.go": {
			FilePath: "deleted.go",
			FileHash: "deleted_hash",
			ChunkHashes: map[string]string{
				"code::deleted.go::__file__": "h3",
			},
		},
	}

	candidates := []string{"unchanged.go", "changed.go", "new.go"}

	delta, err := ComputeFileDelta(dir, candidates, cached)
	if err != nil {
		t.Fatal(err)
	}

	if len(delta.UnchangedFiles) != 1 || delta.UnchangedFiles[0] != "unchanged.go" {
		t.Errorf("unexpected unchanged: %v", delta.UnchangedFiles)
	}
	if len(delta.ChangedFiles) != 1 || delta.ChangedFiles[0] != "changed.go" {
		t.Errorf("unexpected changed: %v", delta.ChangedFiles)
	}
	if len(delta.NewFiles) != 1 || delta.NewFiles[0] != "new.go" {
		t.Errorf("unexpected new: %v", delta.NewFiles)
	}
	if len(delta.DeletedFiles) != 1 || delta.DeletedFiles[0] != "deleted.go" {
		t.Errorf("unexpected deleted: %v", delta.DeletedFiles)
	}
}

func TestClearCodeFileHashes(t *testing.T) {
	db := setupTestDB(t)

	input := map[string]CodeFileHash{
		"test.go": {
			FilePath:    "test.go",
			FileHash:    "abc",
			ChunkHashes: map[string]string{},
		},
	}
	SaveCodeFileHashes(db, input)

	hashes, _ := LoadCodeFileHashes(db)
	if len(hashes) != 1 {
		t.Fatalf("expected 1 hash, got %d", len(hashes))
	}

	ClearCodeFileHashes(db)

	hashes, _ = LoadCodeFileHashes(db)
	if len(hashes) != 0 {
		t.Fatalf("expected 0 hashes after clear, got %d", len(hashes))
	}
}
