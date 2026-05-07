package search

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// CodeFileHash stores the hash state for a single code file.
type CodeFileHash struct {
	FilePath    string            `json:"file_path"`
	FileHash    string            `json:"file_hash"`
	ChunkHashes map[string]string `json:"chunk_hashes"` // chunk_id → content_hash
}

// LoadCodeFileHashes loads all stored file hashes from the code_file_hashes table.
func LoadCodeFileHashes(db *sql.DB) (map[string]CodeFileHash, error) {
	if db == nil {
		return nil, nil
	}

	// Check if table exists.
	var count int
	err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='code_file_hashes'`).Scan(&count)
	if err != nil || count == 0 {
		return nil, nil
	}

	rows, err := db.Query("SELECT file_path, file_hash, chunk_hashes FROM code_file_hashes")
	if err != nil {
		return nil, fmt.Errorf("query code_file_hashes: %w", err)
	}
	defer rows.Close()

	result := make(map[string]CodeFileHash)
	for rows.Next() {
		var fh CodeFileHash
		var chunkJSON string
		if err := rows.Scan(&fh.FilePath, &fh.FileHash, &chunkJSON); err != nil {
			continue
		}
		fh.ChunkHashes = make(map[string]string)
		if chunkJSON != "" && chunkJSON != "{}" {
			json.Unmarshal([]byte(chunkJSON), &fh.ChunkHashes)
		}
		result[fh.FilePath] = fh
	}
	return result, nil
}

// SaveCodeFileHashes writes file hashes to the code_file_hashes table.
// It replaces all existing entries (full refresh after each ingest).
func SaveCodeFileHashes(db *sql.DB, hashes map[string]CodeFileHash) error {
	if db == nil {
		return fmt.Errorf("no db")
	}

	tx, err := db.Begin()
	if err != nil {
		return err
	}

	if _, err := tx.Exec("DELETE FROM code_file_hashes"); err != nil {
		tx.Rollback()
		return err
	}

	stmt, err := tx.Prepare(`INSERT INTO code_file_hashes (file_path, file_hash, chunk_hashes) VALUES (?, ?, ?)`)
	if err != nil {
		tx.Rollback()
		return err
	}
	defer stmt.Close()

	for _, fh := range hashes {
		chunkJSON, _ := json.Marshal(fh.ChunkHashes)
		if _, err := stmt.Exec(fh.FilePath, fh.FileHash, string(chunkJSON)); err != nil {
			tx.Rollback()
			return err
		}
	}

	return tx.Commit()
}

// ClearCodeFileHashes removes all entries from the code_file_hashes table.
func ClearCodeFileHashes(db *sql.DB) error {
	if db == nil {
		return nil
	}
	_, err := db.Exec("DELETE FROM code_file_hashes")
	return err
}

// HashFileContent computes SHA-256 hash of a file's content.
func HashFileContent(absPath string) (string, error) {
	data, err := os.ReadFile(absPath)
	if err != nil {
		return "", err
	}
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:]), nil
}

// HashString computes SHA-256 hash of a string.
func HashString(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

// DeltaResult holds the result of comparing current files against cached hashes.
type DeltaResult struct {
	// UnchangedFiles are files whose file hash matches — skip parse entirely.
	UnchangedFiles []string
	// ChangedFiles are files whose file hash differs — need re-parse.
	ChangedFiles []string
	// NewFiles are files not in the cache — need full parse + embed.
	NewFiles []string
	// DeletedFiles are files in cache but no longer on disk — need cleanup.
	DeletedFiles []string
}

// ComputeFileDelta compares current candidate files against cached hashes.
func ComputeFileDelta(projectRoot string, candidates []string, cached map[string]CodeFileHash) (*DeltaResult, error) {
	result := &DeltaResult{}

	currentSet := make(map[string]bool, len(candidates))
	for _, rel := range candidates {
		currentSet[rel] = true
	}

	// Detect deleted files.
	for path := range cached {
		if !currentSet[path] {
			result.DeletedFiles = append(result.DeletedFiles, path)
		}
	}

	// Classify current files.
	for _, rel := range candidates {
		absPath := filepath.Join(projectRoot, filepath.FromSlash(rel))
		fileHash, err := HashFileContent(absPath)
		if err != nil {
			// Can't read file — treat as changed to be safe.
			result.ChangedFiles = append(result.ChangedFiles, rel)
			continue
		}

		prev, exists := cached[rel]
		if !exists {
			result.NewFiles = append(result.NewFiles, rel)
		} else if prev.FileHash != fileHash {
			result.ChangedFiles = append(result.ChangedFiles, rel)
		} else {
			result.UnchangedFiles = append(result.UnchangedFiles, rel)
		}
	}

	return result, nil
}
