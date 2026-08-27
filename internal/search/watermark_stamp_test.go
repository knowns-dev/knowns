package search

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeStampFixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	stateDir := filepath.Join(root, "history", "state")
	if err := os.MkdirAll(stateDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	manifest := map[string]any{"entries": map[string]any{
		"task:indexed": map[string]any{
			"entityType": "task", "entityId": "indexed",
			"path": "tasks/task-indexed - A-real-filename.md", "hash": "hash-a", "revision": 6,
		},
		"task:skipped": map[string]any{
			"entityType": "task", "entityId": "skipped",
			"path": "tasks/task-skipped - Another-filename.md", "hash": "hash-b", "revision": 2,
		},
		"doc:doc-1": map[string]any{
			"entityType": "doc", "entityId": "doc-1",
			"path": "docs/guides/thing.md", "hash": "hash-c", "revision": 3,
		},
	}}
	data, _ := json.Marshal(manifest)
	if err := os.WriteFile(filepath.Join(stateDir, "manifest.json"), data, 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
	return root
}

// TestStampClearsStaleForEntitiesTheRebuildCovered is the point of the change:
// a full rebuild can now clear what doctor reports. Before this, watermarks were
// written only by per-entity reconciliation, so a warning could outlive its own
// advertised remediation indefinitely.
func TestStampClearsStaleForEntitiesTheRebuildCovered(t *testing.T) {
	root := writeStampFixture(t)
	// Seed the two broken shapes seen in a real project: never indexed, and
	// indexed once against a path spelled differently from the manifest.
	if err := saveQdrantWatermarks(root, map[string]QdrantIndexWatermark{
		"task:indexed": {EntityType: "task", EntityID: "indexed", CanonicalHash: "hash-a", Revision: 6,
			Path: "tasks/indexed.md", Stale: true},
		"doc:doc-1": {EntityType: "doc", EntityID: "doc-1", CanonicalHash: "hash-c", Revision: 3,
			Path: "docs/guides/thing.md", IndexedHash: "old", IndexedPath: "docs/guides/thing.md", IndexedRevision: 2},
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	now := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)
	stamped, err := StampWatermarksFromGeneration(root, map[string]bool{
		"task:indexed":     true,
		"doc:guides/thing": true,
	}, now)
	if err != nil {
		t.Fatalf("StampWatermarksFromGeneration: %v", err)
	}
	if stamped != 2 {
		t.Fatalf("stamped = %d, want 2", stamped)
	}

	values, err := loadQdrantWatermarks(root)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	task := values["task:indexed"]
	if task.Stale {
		t.Fatal("a rebuilt entity is still marked stale")
	}
	// The manifest spelling wins, which is what the readiness check compares against.
	if task.IndexedPath != "tasks/task-indexed - A-real-filename.md" || task.IndexedHash != "hash-a" || task.IndexedRevision != 6 {
		t.Fatalf("task watermark = %#v", task)
	}
	if !task.IndexedAt.Equal(now) {
		t.Fatalf("indexedAt = %v, want %v", task.IndexedAt, now)
	}
	if doc := values["doc:doc-1"]; doc.IndexedHash != "hash-c" || doc.IndexedRevision != 3 {
		t.Fatalf("doc watermark = %#v", doc)
	}
}

// TestStampLeavesEntitiesTheRebuildSkipped guards the honesty of the change.
// Reindex swallows a per-entity embedding failure, so an entity it dropped
// produces no points. Stamping it from the manifest would replace a visible
// wrong warning with an invisible wrong silence.
func TestStampLeavesEntitiesTheRebuildSkipped(t *testing.T) {
	root := writeStampFixture(t)
	if err := saveQdrantWatermarks(root, map[string]QdrantIndexWatermark{
		"task:skipped": {EntityType: "task", EntityID: "skipped", CanonicalHash: "hash-b", Revision: 2, Stale: true},
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := StampWatermarksFromGeneration(root, map[string]bool{"task:indexed": true}, time.Now().UTC()); err != nil {
		t.Fatalf("StampWatermarksFromGeneration: %v", err)
	}
	values, err := loadQdrantWatermarks(root)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if skipped := values["task:skipped"]; !skipped.Stale || skipped.IndexedHash != "" {
		t.Fatalf("an entity the rebuild never covered was stamped indexed: %#v", skipped)
	}
}

// A removal in flight must not be resurrected as indexed by a bulk rebuild.
func TestStampSkipsEntitiesPendingRemoval(t *testing.T) {
	root := writeStampFixture(t)
	if err := saveQdrantWatermarks(root, map[string]QdrantIndexWatermark{
		"task:indexed": {EntityType: "task", EntityID: "indexed", Stale: true, PendingRemoval: true},
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := StampWatermarksFromGeneration(root, map[string]bool{"task:indexed": true}, time.Now().UTC()); err != nil {
		t.Fatalf("StampWatermarksFromGeneration: %v", err)
	}
	values, _ := loadQdrantWatermarks(root)
	if got := values["task:indexed"]; got.IndexedHash != "" || !got.PendingRemoval {
		t.Fatalf("pending removal was stamped indexed: %#v", got)
	}
}
