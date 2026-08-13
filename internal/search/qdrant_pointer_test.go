package search

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestNewCollectionUUIDFormat(t *testing.T) {
	id, err := NewCollectionUUID()
	if err != nil {
		t.Fatalf("NewCollectionUUID: %v", err)
	}
	if len(id) != 36 {
		t.Fatalf("uuid length = %d, want 36", len(id))
	}
	if strings.Count(id, "-") != 4 {
		t.Fatalf("uuid = %q, want 4 hyphens", id)
	}
	if id[14] != '4' {
		t.Fatalf("uuid version = %c, want 4 (uuid %q)", id[14], id)
	}
}

func TestCollectionNameFromUUID(t *testing.T) {
	uuid := "8f2c6a7b-91d4-4f6a-b9f7-2ef84d72a9c1"
	got := CollectionNameFromUUID(uuid)
	want := "kn_8f2c6a7b91d44f6ab9f72ef84d72a9c1"
	if got != want {
		t.Fatalf("CollectionNameFromUUID(%q) = %q, want %q", uuid, got, want)
	}
	if !strings.HasPrefix(got, QdrantCollectionNamePrefix) {
		t.Fatalf("collection name %q missing prefix %q", got, QdrantCollectionNamePrefix)
	}
	if strings.Contains(got, "-") {
		t.Fatalf("collection name %q must not contain dashes", got)
	}
}

func TestStoreRootFingerprint(t *testing.T) {
	a := StoreRootFingerprint("/tmp/store-a")
	b := StoreRootFingerprint("/tmp/store-a")
	if a != b {
		t.Fatalf("fingerprint not deterministic: %q vs %q", a, b)
	}
	if !strings.HasPrefix(a, "sha256:") || len(a) != len("sha256:")+64 {
		t.Fatalf("fingerprint = %q, want sha256: prefix with 64 hex chars", a)
	}
	if c := StoreRootFingerprint("/tmp/store-b"); c == a {
		t.Fatalf("fingerprints for different roots must differ")
	}
	// Path cleaning: trailing slash must not change the fingerprint.
	if StoreRootFingerprint("/tmp/store-a") != StoreRootFingerprint("/tmp/store-a/") {
		t.Fatal("fingerprint should be stable across path cleaning")
	}
}

func TestSaveLoadQdrantPointerRoundTrip(t *testing.T) {
	root := t.TempDir()
	lastIndexed := time.Date(2026, 8, 13, 12, 0, 0, 0, time.UTC)
	p := &QdrantPointer{
		Backend:        "qdrant",
		CollectionUUID: "8f2c6a7b-91d4-4f6a-b9f7-2ef84d72a9c1",
		SchemaVersion:  QdrantPointerSchemaVersion,
		ChunkVersion:   ChunkVersion,
		Embedding: QdrantEmbeddingPointer{
			Provider:   "ollama",
			Model:      "qwen3-embedding:0.6b",
			Dimensions: 1024,
			Distance:   "cosine",
		},
		Owner: QdrantOwnerPointer{
			ProjectID:            "knowns-go",
			StoreRootFingerprint: StoreRootFingerprint(root),
		},
		LastIndexedAt: &lastIndexed,
		ChunkCount:    42,
	}
	if err := SaveQdrantPointer(root, p); err != nil {
		t.Fatalf("SaveQdrantPointer: %v", err)
	}

	// Collection name is derived from the UUID when omitted.
	if p.CollectionName != CollectionNameFromUUID(p.CollectionUUID) {
		t.Fatalf("collectionName = %q, want %q", p.CollectionName, CollectionNameFromUUID(p.CollectionUUID))
	}

	got, err := LoadQdrantPointer(root)
	if err != nil {
		t.Fatalf("LoadQdrantPointer: %v", err)
	}
	if got == nil {
		t.Fatal("LoadQdrantPointer returned nil")
	}
	if got.CollectionUUID != p.CollectionUUID || got.CollectionName != p.CollectionName {
		t.Fatalf("collection identity mismatch: %#v", got)
	}
	if got.SchemaVersion != QdrantPointerSchemaVersion || got.ChunkVersion != ChunkVersion {
		t.Fatalf("versions = %d/%d, want %d/%d", got.SchemaVersion, got.ChunkVersion, QdrantPointerSchemaVersion, ChunkVersion)
	}
	if got.Embedding != p.Embedding {
		t.Fatalf("embedding mismatch: %#v", got.Embedding)
	}
	if got.Owner != p.Owner {
		t.Fatalf("owner mismatch: %#v", got.Owner)
	}
	if got.LastIndexedAt == nil || !got.LastIndexedAt.Equal(lastIndexed) {
		t.Fatalf("lastIndexedAt = %v, want %v", got.LastIndexedAt, lastIndexed)
	}
	if got.ChunkCount != 42 {
		t.Fatalf("chunkCount = %d, want 42", got.ChunkCount)
	}
}

func TestLoadQdrantPointerMissing(t *testing.T) {
	got, err := LoadQdrantPointer(t.TempDir())
	if err != nil {
		t.Fatalf("LoadQdrantPointer on missing pointer: %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil pointer, got %#v", got)
	}
}

func TestSaveQdrantPointerRequiresUUID(t *testing.T) {
	if err := SaveQdrantPointer(t.TempDir(), &QdrantPointer{CollectionUUID: ""}); err == nil {
		t.Fatal("SaveQdrantPointer with empty UUID succeeded, want error")
	}
	if err := SaveQdrantPointer(t.TempDir(), nil); err == nil {
		t.Fatal("SaveQdrantPointer with nil pointer succeeded, want error")
	}
}

func TestQdrantPointerMetadataOnlyNoVectors(t *testing.T) {
	root := t.TempDir()
	// Simulate a pre-existing .search directory holding a legacy SQLite index.
	searchDir := filepath.Join(root, ".search")
	if err := os.MkdirAll(searchDir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(searchDir, "index.db"), []byte("sqlite-bytes"), 0644); err != nil {
		t.Fatalf("write legacy index.db: %v", err)
	}

	if err := SaveQdrantPointer(root, &QdrantPointer{
		CollectionUUID: "8f2c6a7b-91d4-4f6a-b9f7-2ef84d72a9c1",
		ChunkVersion:   ChunkVersion,
	}); err != nil {
		t.Fatalf("SaveQdrantPointer: %v", err)
	}
	if err := AppendQdrantGeneration(root, QdrantGenerationRecord{
		Generation:     1,
		CollectionUUID: "8f2c6a7b-91d4-4f6a-b9f7-2ef84d72a9c1",
		Status:         QdrantGenerationStatusActive,
		CreatedAt:      time.Now().UTC(),
	}); err != nil {
		t.Fatalf("AppendQdrantGeneration: %v", err)
	}

	entries, err := os.ReadDir(searchDir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	got := make([]string, 0, len(entries))
	for _, e := range entries {
		got = append(got, e.Name())
	}
	for _, f := range got {
		switch f {
		case QdrantPointerFileName, QdrantGenerationsFileName, "index.db":
			// index.db is the pre-existing legacy file; pointer helpers must
			// not add or modify it.
		default:
			t.Fatalf("unexpected file under .search created by pointer helpers: %q", f)
		}
	}
	for _, forbidden := range []string{"embeddings.bin", "index.json", "vectors.bin", "qdrant-data"} {
		for _, name := range got {
			if strings.Contains(name, forbidden) {
				t.Fatalf("vector data file %q present under project .search", name)
			}
		}
	}
	// The pointer file itself must not contain raw vectors or embeddings.
	data, err := os.ReadFile(QdrantPointerPath(root))
	if err != nil {
		t.Fatalf("read pointer: %v", err)
	}
	if strings.Contains(string(data), "embeddingValues") || strings.Contains(string(data), `"vector":`) {
		t.Fatalf("pointer file contains vector payload fields")
	}
}

func TestAppendAndLoadQdrantGenerations(t *testing.T) {
	root := t.TempDir()
	created := time.Date(2026, 8, 13, 10, 0, 0, 0, time.UTC)
	retired := created.Add(time.Hour)

	first := QdrantGenerationRecord{
		Generation:     1,
		CollectionUUID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		CollectionName: CollectionNameFromUUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
		SchemaVersion:  QdrantPointerSchemaVersion,
		ChunkVersion:   ChunkVersion,
		Embedding:      QdrantEmbeddingPointer{Provider: "local", Model: "gte-small", Dimensions: 384},
		Status:         QdrantGenerationStatusInactive,
		ChunkCount:     100,
		CreatedAt:      created,
		RetiredAt:      &retired,
	}
	second := QdrantGenerationRecord{
		Generation:     2,
		CollectionUUID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		CollectionName: CollectionNameFromUUID("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
		Status:         QdrantGenerationStatusActive,
		ChunkCount:     0,
		CreatedAt:      created.Add(2 * time.Hour),
	}
	for _, rec := range []QdrantGenerationRecord{first, second} {
		if err := AppendQdrantGeneration(root, rec); err != nil {
			t.Fatalf("AppendQdrantGeneration: %v", err)
		}
	}

	records, err := LoadQdrantGenerations(root)
	if err != nil {
		t.Fatalf("LoadQdrantGenerations: %v", err)
	}
	if len(records) != 2 {
		t.Fatalf("records = %d, want 2", len(records))
	}
	if records[0].Generation != 1 || records[0].Status != QdrantGenerationStatusInactive || records[0].ChunkCount != 100 {
		t.Fatalf("record[0] = %#v", records[0])
	}
	if records[0].RetiredAt == nil || !records[0].RetiredAt.Equal(retired) {
		t.Fatalf("record[0].RetiredAt = %v, want %v", records[0].RetiredAt, retired)
	}
	if records[1].Generation != 2 || records[1].Status != QdrantGenerationStatusActive || records[1].CollectionName != second.CollectionName {
		t.Fatalf("record[1] = %#v", records[1])
	}

	// Missing file returns an empty slice, not an error.
	empty, err := LoadQdrantGenerations(t.TempDir())
	if err != nil || len(empty) != 0 {
		t.Fatalf("LoadQdrantGenerations(missing) = %v, %v; want empty, nil", empty, err)
	}
}

func TestSaveQdrantPointerFillsDerivedFields(t *testing.T) {
	root := t.TempDir()
	// Only the UUID is provided; backend/schema/distance/name must be filled.
	p := &QdrantPointer{CollectionUUID: "8f2c6a7b-91d4-4f6a-b9f7-2ef84d72a9c1"}
	if err := SaveQdrantPointer(root, p); err != nil {
		t.Fatalf("SaveQdrantPointer: %v", err)
	}
	if p.Backend != "qdrant" || p.SchemaVersion != QdrantPointerSchemaVersion || p.Embedding.Distance != QdrantDefaultDistance {
		t.Fatalf("derived fields not filled: %#v", p)
	}
}
