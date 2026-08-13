package search

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Qdrant pointer metadata (spec: qdrant-default-vector-backend, D5/D6).
//
// Project stores keep only lightweight metadata pointers under
// <storeRoot>/.search/ (qdrant.json + qdrant-generations.jsonl). Vectors,
// embeddings, and collections live in the Qdrant runtime under
// ~/.knowns/runtime/qdrant, never under the project .knowns directory.

const (
	// QdrantPointerSchemaVersion is the schema version of qdrant.json.
	QdrantPointerSchemaVersion = 1

	// QdrantPointerFileName is the active collection pointer file, stored
	// under <storeRoot>/.search/.
	QdrantPointerFileName = "qdrant.json"

	// QdrantGenerationsFileName is the append-only generation history file,
	// stored under <storeRoot>/.search/.
	QdrantGenerationsFileName = "qdrant-generations.jsonl"

	// QdrantCollectionNamePrefix is prepended to the dash-free collection UUID
	// to form the Qdrant collection name (spec FR-7/NFR-2).
	QdrantCollectionNamePrefix = "kn_"

	// QdrantDefaultDistance is the default vector distance metric for new
	// Qdrant collections.
	QdrantDefaultDistance = "cosine"
)

// Generation status values used in qdrant-generations.jsonl (spec D6/D7).
const (
	// QdrantGenerationStatusActive marks the currently pointed-at generation.
	QdrantGenerationStatusActive = "active"
	// QdrantGenerationStatusInactive marks a prior generation retained only
	// for rollback within the retention window.
	QdrantGenerationStatusInactive = "inactive"
)

// QdrantEmbeddingPointer identifies the embedding identity used to build a
// collection so search can detect stale indexes after model or dimension
// changes (spec FR-8/NFR-6).
type QdrantEmbeddingPointer struct {
	Provider   string `json:"provider"`
	Model      string `json:"model"`
	Dimensions int    `json:"dimensions"`
	Distance   string `json:"distance,omitempty"` // "cosine" by default
}

// QdrantOwnerPointer identifies the Knowns store that owns a collection
// (spec D6/FR-6). If the owner fingerprint does not match the active store,
// the pointer is treated as stale and a new collection UUID is created.
type QdrantOwnerPointer struct {
	ProjectID            string `json:"projectId,omitempty"`
	StoreRootFingerprint string `json:"storeRootFingerprint,omitempty"`
}

// QdrantPointer is the metadata-only pointer a project store keeps for its
// active Qdrant collection. It never contains vectors or raw text (spec D5).
type QdrantPointer struct {
	// Backend is the semantic vector backend ("qdrant").
	Backend string `json:"backend"`
	// CollectionUUID is the stable, generated identity of the active collection.
	CollectionUUID string `json:"collectionUUID"`
	// CollectionName is the Qdrant collection name derived from CollectionUUID.
	CollectionName string `json:"collectionName"`
	// SchemaVersion is the pointer schema version (QdrantPointerSchemaVersion).
	SchemaVersion int `json:"schemaVersion"`
	// ChunkVersion is the chunking/embedding logic version that built the index.
	ChunkVersion int `json:"chunkVersion"`
	// Embedding records the embedding identity used to build the collection.
	Embedding QdrantEmbeddingPointer `json:"embedding"`
	// Owner records which store owns this collection.
	Owner QdrantOwnerPointer `json:"owner"`
	// LastIndexedAt is the time the active collection was last fully indexed.
	// nil means the collection has never been indexed yet.
	LastIndexedAt *time.Time `json:"lastIndexedAt"`
	// ChunkCount is the number of chunks indexed into the active collection.
	ChunkCount int64 `json:"chunkCount"`
}

// QdrantGenerationRecord is one line of qdrant-generations.jsonl, recording a
// collection generation swap for rollback and cleanup bookkeeping (spec D6/D7).
type QdrantGenerationRecord struct {
	Generation     int                    `json:"generation"`
	CollectionUUID string                 `json:"collectionUUID"`
	CollectionName string                 `json:"collectionName"`
	SchemaVersion  int                    `json:"schemaVersion"`
	ChunkVersion   int                    `json:"chunkVersion"`
	Embedding      QdrantEmbeddingPointer `json:"embedding"`
	Status         string                 `json:"status"` // "active" | "inactive"
	ChunkCount     int64                  `json:"chunkCount"`
	CreatedAt      time.Time              `json:"createdAt"`
	SwappedAt      time.Time              `json:"swappedAt,omitempty"`
	RetiredAt      *time.Time             `json:"retiredAt,omitempty"`
}

// NewCollectionUUID generates a random UUIDv4 used as the stable identity of a
// Qdrant collection (spec D6/FR-5). The UUID is the ownership key; project
// paths are never used as collection identifiers (NFR-2).
func NewCollectionUUID() (string, error) {
	id, err := uuid.NewRandom()
	if err != nil {
		return "", fmt.Errorf("generate collection uuid: %w", err)
	}
	return id.String(), nil
}

// CollectionNameFromUUID derives the Qdrant collection name from a collection
// UUID: "kn_" + dash-free UUID, e.g. "kn_8f2c6a7b91d44f6ab9f72ef84d72a9c1".
func CollectionNameFromUUID(collectionUUID string) string {
	return QdrantCollectionNamePrefix + strings.ReplaceAll(collectionUUID, "-", "")
}

// QdrantPointerPath returns the active pointer file path for a store root.
func QdrantPointerPath(storeRoot string) string {
	return filepath.Join(storeRoot, ".search", QdrantPointerFileName)
}

// QdrantGenerationsPath returns the generation history file path for a store root.
func QdrantGenerationsPath(storeRoot string) string {
	return filepath.Join(storeRoot, ".search", QdrantGenerationsFileName)
}

// LoadQdrantPointer reads the active pointer. It returns (nil, nil) when no
// pointer file exists yet.
func LoadQdrantPointer(storeRoot string) (*QdrantPointer, error) {
	path := QdrantPointerPath(storeRoot)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read qdrant pointer: %w", err)
	}
	var p QdrantPointer
	if err := json.Unmarshal(data, &p); err != nil {
		return nil, fmt.Errorf("parse qdrant pointer %s: %w", path, err)
	}
	return &p, nil
}

// SaveQdrantPointer atomically writes the active pointer file. The collection
// name is derived from the UUID when omitted. The pointer file is metadata
// only; no vectors or embeddings are ever written under the store root.
func SaveQdrantPointer(storeRoot string, p *QdrantPointer) error {
	if p == nil {
		return fmt.Errorf("save qdrant pointer: pointer is required")
	}
	if strings.TrimSpace(p.CollectionUUID) == "" {
		return fmt.Errorf("save qdrant pointer: collectionUUID is required")
	}
	if p.CollectionName == "" {
		p.CollectionName = CollectionNameFromUUID(p.CollectionUUID)
	}
	if p.Backend == "" {
		p.Backend = "qdrant"
	}
	if p.SchemaVersion == 0 {
		p.SchemaVersion = QdrantPointerSchemaVersion
	}
	if p.Embedding.Distance == "" {
		p.Embedding.Distance = QdrantDefaultDistance
	}
	data, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal qdrant pointer: %w", err)
	}
	return atomicWriteSearchFile(QdrantPointerPath(storeRoot), data)
}

// AppendQdrantGeneration appends one JSON line to qdrant-generations.jsonl,
// creating the file when needed.
func AppendQdrantGeneration(storeRoot string, rec QdrantGenerationRecord) error {
	data, err := json.Marshal(rec)
	if err != nil {
		return fmt.Errorf("marshal qdrant generation: %w", err)
	}
	path := QdrantGenerationsPath(storeRoot)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return fmt.Errorf("create .search dir: %w", err)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return fmt.Errorf("append qdrant generation: %w", err)
	}
	defer f.Close()
	if _, err := f.Write(append(data, '\n')); err != nil {
		return fmt.Errorf("append qdrant generation: %w", err)
	}
	return nil
}

// LoadQdrantGenerations reads the full generation history. A missing file
// returns an empty (non-nil) slice.
func LoadQdrantGenerations(storeRoot string) ([]QdrantGenerationRecord, error) {
	path := QdrantGenerationsPath(storeRoot)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return []QdrantGenerationRecord{}, nil
		}
		return nil, fmt.Errorf("read qdrant generations: %w", err)
	}
	var records []QdrantGenerationRecord
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if line == "" {
			continue
		}
		var rec QdrantGenerationRecord
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			return nil, fmt.Errorf("parse qdrant generation line: %w", err)
		}
		records = append(records, rec)
	}
	return records, nil
}

// StoreRootFingerprint returns a stable, metadata-only fingerprint identifying
// a Knowns store root: "sha256:" + hex of the canonical root path. It is used
// by QdrantOwnerPointer to detect pointers copied from a different store; a
// mismatch makes the pointer stale and triggers a fresh collection UUID.
//
// Note: fingerprinting the canonical path is the conservative v1 choice — a
// relocated or duplicated store gets a fresh collection. If a future
// generation-swap task needs move-surviving fingerprints, the input should be
// swapped to a store-local identity (e.g. project ID + stored secret).
func StoreRootFingerprint(storeRoot string) string {
	canonical := filepath.Clean(storeRoot)
	sum := sha256.Sum256([]byte(canonical))
	return "sha256:" + hex.EncodeToString(sum[:])
}

// atomicWriteSearchFile writes data to a temporary file in the same directory
// and renames it over dst, mirroring storage.atomicWrite without importing the
// storage package (which would create a dependency cycle for pointer helpers).
func atomicWriteSearchFile(dst string, data []byte) error {
	dir := filepath.Dir(dst)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("atomicWrite: mkdir %s: %w", dir, err)
	}
	tmp, err := os.CreateTemp(dir, ".tmp-qdrant-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	return os.Rename(tmpName, dst)
}
