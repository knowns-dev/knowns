package search

import (
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// SQLiteVectorStore stores embeddings in a SQLite database.
// Vectors are kept in memory for brute-force cosine similarity search;
// SQLite provides durable storage and metadata queries.
//
// Database location: <dir>/index.db
type SQLiteVectorStore struct {
	dir        string
	dimensions int
	model      string

	db *sql.DB

	mu     sync.RWMutex
	index  []indexEntry
	vecs   []float32
	loaded bool
}

// Compile-time check that SQLiteVectorStore implements VectorStore.
var _ VectorStore = (*SQLiteVectorStore)(nil)

// NewSQLiteVectorStore creates a new SQLite-backed vector store.
func NewSQLiteVectorStore(dir string, model string, dimensions int) *SQLiteVectorStore {
	return &SQLiteVectorStore{
		dir:        dir,
		model:      model,
		dimensions: dimensions,
	}
}

func (s *SQLiteVectorStore) dbPath() string { return filepath.Join(s.dir, "index.db") }

// Load opens the database, creates the schema, and loads all vectors into memory.
func (s *SQLiteVectorStore) Load() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := os.MkdirAll(s.dir, 0755); err != nil {
		return fmt.Errorf("sqlite vecstore: mkdir: %w", err)
	}

	// Auto-migrate from FileVectorStore if old files exist but no index.db.
	s.migrateFromFile()

	db, err := sql.Open("sqlite", s.dbPath()+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return fmt.Errorf("sqlite vecstore: open: %w", err)
	}
	s.db = db

	if err := s.createSchema(); err != nil {
		db.Close()
		s.db = nil
		return fmt.Errorf("sqlite vecstore: schema: %w", err)
	}

	// Load all entries and vectors into memory.
	if err := s.loadIntoMemory(); err != nil {
		db.Close()
		s.db = nil
		return fmt.Errorf("sqlite vecstore: load: %w", err)
	}

	s.loaded = true
	return nil
}

func (s *SQLiteVectorStore) createSchema() error {
	// Auto-migrate: if chunks table exists with old schema (vec_rowid instead
	// of embedding), drop and recreate. The index is rebuilt on reindex anyway.
	var hasEmbedding int
	row := s.db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('chunks') WHERE name='embedding'`)
	if err := row.Scan(&hasEmbedding); err == nil && hasEmbedding == 0 {
		// Check if old table exists at all.
		var hasChunks int
		row2 := s.db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('chunks')`)
		if err := row2.Scan(&hasChunks); err == nil && hasChunks > 0 {
			s.db.Exec("DROP TABLE IF EXISTS chunks")
		}
	}

	// Auto-migrate: if chunks table has parent_section instead of header_path,
	// drop and recreate. The index is rebuilt on reindex anyway.
	var hasHeaderPath int
	row = s.db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('chunks') WHERE name='header_path'`)
	if err := row.Scan(&hasHeaderPath); err == nil && hasHeaderPath == 0 {
		var hasParentSection int
		row2 := s.db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('chunks') WHERE name='parent_section'`)
		if err := row2.Scan(&hasParentSection); err == nil && hasParentSection > 0 {
			s.db.Exec("DROP TABLE IF EXISTS chunks")
		}
	}

	for _, col := range []string{"memory_layer", "memory_store", "decision_id"} {
		var hasCol int
		row = s.db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('chunks') WHERE name=?`, col)
		if err := row.Scan(&hasCol); err == nil && hasCol == 0 {
			if _, alterErr := s.db.Exec(`ALTER TABLE chunks ADD COLUMN ` + col + ` TEXT`); alterErr != nil {
				// Fallback: if ALTER fails (e.g. table doesn't exist yet), let
				// the CREATE TABLE below handle it.
				_ = alterErr
			}
		}
	}

	schema := `
CREATE TABLE IF NOT EXISTS metadata (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
    id              TEXT PRIMARY KEY,
    type            TEXT NOT NULL,
    content         TEXT NOT NULL DEFAULT '',
    token_count     INTEGER DEFAULT 0,
    embedding       BLOB,

    doc_path        TEXT,
    section         TEXT,
    heading_level   INTEGER,
    header_path     TEXT,
    position        INTEGER,

	    task_id         TEXT,
	    field           TEXT,
	    status          TEXT,
	    priority        TEXT,
	    labels          TEXT,

	    memory_layer    TEXT,
	    memory_store    TEXT,
	    decision_id     TEXT,

	    name            TEXT,
	    signature       TEXT,
	    visibility      TEXT,
	    detail          TEXT
);

CREATE TABLE IF NOT EXISTS content_hashes (
    source_id TEXT PRIMARY KEY,
    hash      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_type ON chunks(type);
CREATE INDEX IF NOT EXISTS idx_chunks_doc_path ON chunks(doc_path);
CREATE INDEX IF NOT EXISTS idx_chunks_task_id ON chunks(task_id);
CREATE TABLE IF NOT EXISTS code_file_hashes (
    file_path    TEXT PRIMARY KEY,
    file_hash    TEXT NOT NULL,
    chunk_hashes TEXT NOT NULL DEFAULT '{}',
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
`
	if _, err := s.db.Exec(schema); err != nil {
		return err
	}

	if _, err := s.db.Exec(`DROP TABLE IF EXISTS code_symbols; DROP TABLE IF EXISTS code_edges;`); err != nil {
		return err
	}

	// Auto-migrate: add name and signature columns if missing.
	for _, col := range []string{"name", "signature", "visibility", "detail"} {
		var hasCol int
		row := s.db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('chunks') WHERE name=?`, col)
		if err := row.Scan(&hasCol); err == nil && hasCol == 0 {
			s.db.Exec(`ALTER TABLE chunks ADD COLUMN ` + col + ` TEXT`)
		}
	}

	return nil
}

func (s *SQLiteVectorStore) loadIntoMemory() error {
	rows, err := s.db.Query(`
		SELECT id, type, content, token_count, embedding,
		       doc_path, section, heading_level, header_path, position,
		       task_id, field, status, priority, labels,
		       COALESCE(memory_layer, ''), COALESCE(memory_store, ''), COALESCE(decision_id, ''),
		       COALESCE(name, ''), COALESCE(signature, ''), COALESCE(visibility, ''), COALESCE(detail, '')
		FROM chunks
	`)
	if err != nil {
		return err
	}
	defer rows.Close()

	s.index = nil
	s.vecs = nil

	for rows.Next() {
		var entry indexEntry
		var embBlob []byte
		var content sql.NullString
		var docPath, section, parentSection sql.NullString
		var headingLevel, position sql.NullInt64
		var taskID, field, status, priority, labels sql.NullString
		var memoryLayer, memoryStore, decisionID string
		var name, signature, visibility, detail string

		if err := rows.Scan(
			&entry.ID, &entry.Type, &content, &entry.TokenCount, &embBlob,
			&docPath, &section, &headingLevel, &parentSection, &position,
			&taskID, &field, &status, &priority, &labels,
			&memoryLayer, &memoryStore, &decisionID,
			&name, &signature, &visibility, &detail,
		); err != nil {
			return err
		}

		entry.DocPath = docPath.String
		entry.Section = section.String
		entry.HeadingLevel = int(headingLevel.Int64)
		entry.HeaderPath = parentSection.String
		entry.Position = int(position.Int64)
		entry.TaskID = taskID.String
		entry.Field = field.String
		entry.Status = status.String
		entry.Priority = priority.String
		entry.MemoryLayer = memoryLayer
		entry.MemoryStore = memoryStore
		entry.DecisionID = decisionID
		entry.Content = content.String
		entry.Name = name
		entry.Signature = signature
		entry.Visibility = visibility
		entry.Detail = detail

		if labels.Valid && labels.String != "" {
			_ = json.Unmarshal([]byte(labels.String), &entry.Labels)
		}

		// Decode embedding blob to float32 slice.
		if len(embBlob) > 0 {
			floatCount := len(embBlob) / 4
			entry.Offset = len(s.vecs)
			for i := 0; i < floatCount; i++ {
				bits := binary.LittleEndian.Uint32(embBlob[i*4 : (i+1)*4])
				s.vecs = append(s.vecs, math.Float32frombits(bits))
			}
		}

		s.index = append(s.index, entry)
	}
	return rows.Err()
}

// Save writes all in-memory state to the database in a single transaction.
func (s *SQLiteVectorStore) Save() error {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if s.db == nil {
		return fmt.Errorf("sqlite vecstore: not loaded")
	}

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Clear existing data.
	if _, err := tx.Exec("DELETE FROM chunks"); err != nil {
		return err
	}

	// Insert all chunks (use OR REPLACE to handle any duplicates gracefully).
	stmt, err := tx.Prepare(`
		INSERT OR REPLACE INTO chunks (id, type, content, token_count, embedding,
		    doc_path, section, heading_level, header_path, position,
		    task_id, field, status, priority, labels,
		    memory_layer, memory_store, decision_id,
		    name, signature, visibility, detail)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, entry := range s.index {
		// Encode embedding to blob.
		var embBlob []byte
		start := entry.Offset
		end := start + s.dimensions
		if end <= len(s.vecs) {
			embBlob = make([]byte, s.dimensions*4)
			for i := 0; i < s.dimensions; i++ {
				binary.LittleEndian.PutUint32(embBlob[i*4:], math.Float32bits(s.vecs[start+i]))
			}
		}

		var labelsJSON *string
		if len(entry.Labels) > 0 {
			b, _ := json.Marshal(entry.Labels)
			str := string(b)
			labelsJSON = &str
		}

		if _, err := stmt.Exec(
			entry.ID, entry.Type, entry.Content, entry.TokenCount, embBlob,
			nullStr(entry.DocPath), nullStr(entry.Section),
			nullInt(entry.HeadingLevel), nullStr(entry.HeaderPath),
			nullInt(entry.Position),
			nullStr(entry.TaskID), nullStr(entry.Field),
			nullStr(entry.Status), nullStr(entry.Priority),
			labelsJSON,
			nullStr(entry.MemoryLayer), nullStr(entry.MemoryStore), nullStr(entry.DecisionID),
			nullStr(entry.Name), nullStr(entry.Signature), nullStr(entry.Visibility), nullStr(entry.Detail),
		); err != nil {
			return err
		}
	}

	// Update metadata.
	now := time.Now()
	meta := map[string]string{
		"model":        s.model,
		"dimensions":   fmt.Sprintf("%d", s.dimensions),
		"indexedAt":    now.Format(time.RFC3339),
		"chunkCount":   fmt.Sprintf("%d", len(s.index)),
		"chunkVersion": fmt.Sprintf("%d", ChunkVersion),
	}
	for k, v := range meta {
		if _, err := tx.Exec(
			"INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)", k, v,
		); err != nil {
			return err
		}
	}

	return tx.Commit()
}

// Clear removes all data from the store (in-memory and database).
func (s *SQLiteVectorStore) Clear() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.index = nil
	s.vecs = nil

	if s.db != nil {
		s.db.Exec("DELETE FROM chunks")
		s.db.Exec("DELETE FROM metadata")
		s.db.Exec("DELETE FROM content_hashes")
	}
	return nil
}

// AddChunks appends embedded chunks to the in-memory store.
func (s *SQLiteVectorStore) AddChunks(chunks []Chunk) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Build set of existing IDs for deduplication.
	existing := make(map[string]bool, len(s.index))
	for _, e := range s.index {
		existing[e.ID] = true
	}

	for _, c := range chunks {
		if len(c.Embedding) != s.dimensions {
			if c.Type != ChunkTypeCode || len(c.Embedding) != 0 {
				continue
			}
		}
		// Skip duplicates (idempotent re-indexing).
		if existing[c.ID] {
			continue
		}

		offset := len(s.vecs)
		s.vecs = append(s.vecs, c.Embedding...)

		s.index = append(s.index, indexEntry{
			ID:           c.ID,
			Type:         c.Type,
			Offset:       offset,
			TokenCount:   c.TokenCount,
			DocPath:      c.DocPath,
			Section:      c.Section,
			HeadingLevel: c.HeadingLevel,
			HeaderPath:   c.HeaderPath,
			Position:     c.Position,
			TaskID:       c.TaskID,
			Field:        c.Field,
			Status:       c.Status,
			Priority:     c.Priority,
			Labels:       c.Labels,
			MemoryLayer:  c.MemoryLayer,
			MemoryStore:  c.MemoryStore,
			Name:         c.Name,
			Signature:    c.Signature,
			Visibility:   c.Visibility,
			Detail:       c.Detail,
			Content:      c.Content,
		})
	}
}

// RemoveByPrefix removes all chunks whose ID starts with prefix.
func (s *SQLiteVectorStore) RemoveByPrefix(prefix string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	var newIndex []indexEntry
	var newVecs []float32

	for _, entry := range s.index {
		if len(entry.ID) >= len(prefix) && entry.ID[:len(prefix)] == prefix {
			continue
		}
		start := entry.Offset
		end := start + s.dimensions
		if end > len(s.vecs) {
			if entry.Type == ChunkTypeCode {
				newIndex = append(newIndex, entry)
			}
			continue
		}

		newOffset := len(newVecs)
		newVecs = append(newVecs, s.vecs[start:end]...)
		entry.Offset = newOffset
		newIndex = append(newIndex, entry)
	}

	s.index = newIndex
	s.vecs = newVecs
}

// RemoveByIDs removes chunks whose IDs are in the given set.
func (s *SQLiteVectorStore) RemoveByIDs(ids []string) {
	if len(ids) == 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	remove := make(map[string]bool, len(ids))
	for _, id := range ids {
		remove[id] = true
	}

	var newIndex []indexEntry
	var newVecs []float32

	for _, entry := range s.index {
		if remove[entry.ID] {
			continue
		}
		start := entry.Offset
		end := start + s.dimensions
		if end > len(s.vecs) {
			if entry.Type == ChunkTypeCode {
				newIndex = append(newIndex, entry)
			}
			continue
		}

		newOffset := len(newVecs)
		newVecs = append(newVecs, s.vecs[start:end]...)
		entry.Offset = newOffset
		newIndex = append(newIndex, entry)
	}

	s.index = newIndex
	s.vecs = newVecs
}

// Search performs brute-force cosine similarity search.
func (s *SQLiteVectorStore) Search(queryVec []float32, opts VectorSearchOpts) []ScoredChunk {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if len(queryVec) != s.dimensions || len(s.index) == 0 {
		return nil
	}

	if opts.TopK <= 0 {
		opts.TopK = 20
	}
	if opts.Threshold <= 0 {
		opts.Threshold = 0.3
	}

	type scored struct {
		idx   int
		score float64
	}
	var candidates []scored

	for i, entry := range s.index {
		if opts.ChunkType != "" && entry.Type != opts.ChunkType {
			continue
		}
		start := entry.Offset
		end := start + s.dimensions
		if end > len(s.vecs) {
			continue
		}
		vec := s.vecs[start:end]
		sim := CosineSimilarity(queryVec, vec)
		if sim >= opts.Threshold {
			candidates = append(candidates, scored{i, sim})
		}
	}

	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].score > candidates[j].score
	})

	if len(candidates) > opts.TopK {
		candidates = candidates[:opts.TopK]
	}

	results := make([]ScoredChunk, len(candidates))
	for i, c := range candidates {
		entry := s.index[c.idx]
		results[i] = ScoredChunk{
			Chunk: Chunk{
				ID:           entry.ID,
				Type:         entry.Type,
				TokenCount:   entry.TokenCount,
				DocPath:      entry.DocPath,
				Section:      entry.Section,
				HeadingLevel: entry.HeadingLevel,
				HeaderPath:   entry.HeaderPath,
				Position:     entry.Position,
				TaskID:       entry.TaskID,
				Field:        entry.Field,
				Status:       entry.Status,
				Priority:     entry.Priority,
				Labels:       entry.Labels,
				MemoryLayer:  entry.MemoryLayer,
				MemoryStore:  entry.MemoryStore,
				Name:         entry.Name,
				Signature:    entry.Signature,
				Content:      entry.Content,
			},
			Score: c.score,
		}
	}
	return results
}

// Count returns the number of indexed chunks.
func (s *SQLiteVectorStore) Count() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.index)
}

// NeedsRebuild returns true if the stored model differs from the current one
// or if the chunk version has changed.
func (s *SQLiteVectorStore) NeedsRebuild(model string) bool {
	if s.db == nil {
		return true
	}
	var storedModel string
	err := s.db.QueryRow("SELECT value FROM metadata WHERE key = 'model'").Scan(&storedModel)
	if err != nil {
		return true
	}
	if storedModel != model {
		return true
	}
	var storedVersion string
	err = s.db.QueryRow("SELECT value FROM metadata WHERE key = 'chunkVersion'").Scan(&storedVersion)
	if err != nil {
		return true // no version stored → needs rebuild
	}
	return storedVersion != fmt.Sprintf("%d", ChunkVersion)
}

// Stats returns basic statistics about the vector store.
func (s *SQLiteVectorStore) Stats() (chunkCount int, model string, indexedAt time.Time) {
	if s.db == nil {
		// Try to open DB just for reading stats.
		dbPath := s.dbPath()
		if _, err := os.Stat(dbPath); err != nil {
			return 0, "", time.Time{}
		}
		db, err := sql.Open("sqlite", dbPath+"?mode=ro")
		if err != nil {
			return 0, "", time.Time{}
		}
		defer db.Close()
		return readStatsFromDB(db)
	}
	return readStatsFromDB(s.db)
}

func readStatsFromDB(db *sql.DB) (int, string, time.Time) {
	rows, err := db.Query("SELECT key, value FROM metadata WHERE key IN ('model', 'indexedAt', 'chunkCount')")
	if err != nil {
		return 0, "", time.Time{}
	}
	defer rows.Close()

	var model string
	var indexedAt time.Time
	var chunkCount int

	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			continue
		}
		switch k {
		case "model":
			model = v
		case "indexedAt":
			indexedAt, _ = time.Parse(time.RFC3339, v)
		case "chunkCount":
			fmt.Sscanf(v, "%d", &chunkCount)
		}
	}
	return chunkCount, model, indexedAt
}

// Close closes the database connection.
func (s *SQLiteVectorStore) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db != nil {
		err := s.db.Close()
		s.db = nil
		return err
	}
	return nil
}

// Model returns the embedding model name.
func (s *SQLiteVectorStore) Model() string { return s.model }

// GetContentHash returns the stored hash for a source ID, or empty if not found.
func (s *SQLiteVectorStore) GetContentHash(sourceID string) string {
	if s.db == nil {
		return ""
	}
	var hash string
	err := s.db.QueryRow("SELECT hash FROM content_hashes WHERE source_id = ?", sourceID).Scan(&hash)
	if err != nil {
		return ""
	}
	return hash
}

// SetContentHash stores a content hash for a source ID.
func (s *SQLiteVectorStore) SetContentHash(sourceID, hash string) {
	if s.db == nil {
		return
	}
	s.db.Exec("INSERT OR REPLACE INTO content_hashes (source_id, hash) VALUES (?, ?)", sourceID, hash)
}

// DeleteContentHash removes the hash for a source ID.
func (s *SQLiteVectorStore) DeleteContentHash(sourceID string) {
	if s.db == nil {
		return
	}
	s.db.Exec("DELETE FROM content_hashes WHERE source_id = ?", sourceID)
}

// ListContentHashes returns all stored source_id → hash pairs.
func (s *SQLiteVectorStore) ListContentHashes() map[string]string {
	if s.db == nil {
		return nil
	}
	rows, err := s.db.Query("SELECT source_id, hash FROM content_hashes")
	if err != nil {
		return nil
	}
	defer rows.Close()
	result := make(map[string]string)
	for rows.Next() {
		var id, hash string
		if err := rows.Scan(&id, &hash); err == nil {
			result[id] = hash
		}
	}
	return result
}

// migrateFromFile checks for old FileVectorStore files and migrates to SQLite.
// Must be called before opening the database (no lock held by caller pattern — but
// we are called from Load which holds the write lock).
func (s *SQLiteVectorStore) migrateFromFile() {
	dbPath := s.dbPath()
	indexPath := filepath.Join(s.dir, "index.json")
	embPath := filepath.Join(s.dir, "embeddings.bin")

	// Only migrate if no index.db but old files exist.
	if _, err := os.Stat(dbPath); err == nil {
		return // DB already exists
	}
	if _, err := os.Stat(indexPath); err != nil {
		return // No old index
	}

	// Load the old FileVectorStore data.
	old := NewFileVectorStore(s.dir, s.model, s.dimensions)
	if err := old.Load(); err != nil {
		return
	}
	if old.Count() == 0 {
		return
	}

	// Open a temporary DB, write data, close.
	db, err := sql.Open("sqlite", dbPath+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return
	}
	defer db.Close()

	// Create schema.
	schema := `
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chunks (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, content TEXT NOT NULL,
    token_count INTEGER DEFAULT 0, embedding BLOB,
    doc_path TEXT, section TEXT, heading_level INTEGER,
    header_path TEXT, position INTEGER,
    task_id TEXT, field TEXT, status TEXT, priority TEXT, labels TEXT,
	    memory_layer TEXT, memory_store TEXT,
	    name TEXT, signature TEXT, visibility TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_chunks_type ON chunks(type);
CREATE INDEX IF NOT EXISTS idx_chunks_doc_path ON chunks(doc_path);
CREATE INDEX IF NOT EXISTS idx_chunks_task_id ON chunks(task_id);
`
	if _, err := db.Exec(schema); err != nil {
		return
	}

	tx, err := db.Begin()
	if err != nil {
		return
	}

	stmt, err := tx.Prepare(`
		INSERT INTO chunks (id, type, content, token_count, embedding,
		    doc_path, section, heading_level, header_path, position,
		    task_id, field, status, priority, labels,
			    memory_layer, memory_store, name, signature, visibility, detail)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`)
	if err != nil {
		tx.Rollback()
		return
	}
	defer stmt.Close()

	old.mu.RLock()
	for _, entry := range old.index {
		var embBlob []byte
		start := entry.Offset
		end := start + old.dimensions
		if end <= len(old.vecs) {
			embBlob = make([]byte, old.dimensions*4)
			for i := 0; i < old.dimensions; i++ {
				binary.LittleEndian.PutUint32(embBlob[i*4:], math.Float32bits(old.vecs[start+i]))
			}
		}

		var labelsJSON *string
		if len(entry.Labels) > 0 {
			b, _ := json.Marshal(entry.Labels)
			str := string(b)
			labelsJSON = &str
		}

		stmt.Exec(
			entry.ID, entry.Type, "", entry.TokenCount, embBlob,
			nullStr(entry.DocPath), nullStr(entry.Section),
			nullInt(entry.HeadingLevel), nullStr(entry.HeaderPath),
			nullInt(entry.Position),
			nullStr(entry.TaskID), nullStr(entry.Field),
			nullStr(entry.Status), nullStr(entry.Priority),
			labelsJSON,
			nullStr(entry.MemoryLayer), nullStr(entry.MemoryStore),
			nullStr(entry.Name), nullStr(entry.Signature), nullStr(entry.Visibility), nullStr(entry.Detail),
		)
	}
	old.mu.RUnlock()

	// Write metadata.
	count, _, indexedAt := old.Stats()
	meta := map[string]string{
		"model":      s.model,
		"dimensions": fmt.Sprintf("%d", s.dimensions),
		"indexedAt":  indexedAt.Format(time.RFC3339),
		"chunkCount": fmt.Sprintf("%d", count),
	}
	for k, v := range meta {
		tx.Exec("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)", k, v)
	}

	if err := tx.Commit(); err != nil {
		os.Remove(dbPath)
		return
	}

	// Clean up old files.
	os.Remove(indexPath)
	os.Remove(embPath)
	os.Remove(filepath.Join(s.dir, "version.json"))
}

// SQL helper functions.

func nullStr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func nullInt(i int) *int {
	if i == 0 {
		return nil
	}
	return &i
}
