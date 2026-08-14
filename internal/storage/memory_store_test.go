package storage

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

func TestMemoryStoreRejectsNewDecisionMemoryAndConstrainsLegacyWrites(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	store := NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("legacy-decision-memory-policy"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	for _, category := range []string{"decision", " Decision ", "DECISION"} {
		err := store.Memory.Create(&models.MemoryEntry{Title: "Rejected", Category: category})
		if !errors.Is(err, models.ErrLegacyDecisionMemoryWrite) {
			t.Fatalf("Create category %q error = %v", category, err)
		}
	}

	legacy := &models.MemoryEntry{
		ID: "legacy-decision", Title: "Historical choice", Layer: models.MemoryLayerProject,
		Category: "decision", Status: models.MemoryStatusActive, Content: "Historical guidance.",
		CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}
	seedLegacyDecisionMemory(t, store, legacy)
	loaded, err := store.Memory.Get(legacy.ID)
	if err != nil || loaded.Content != legacy.Content {
		t.Fatalf("read legacy memory: entry=%+v err=%v", loaded, err)
	}
	loaded.Title = "Forbidden rewrite"
	if err := store.Memory.Update(loaded); !errors.Is(err, models.ErrLegacyDecisionMemoryWrite) {
		t.Fatalf("active legacy update error = %v", err)
	}
	loaded, _ = store.Memory.Get(legacy.ID)
	loaded.Status = models.MemoryStatusArchived
	loaded.Metadata = map[string]string{"migration": "previewed"}
	if err := store.Memory.Update(loaded); err != nil {
		t.Fatalf("archive legacy memory: %v", err)
	}
	if err := store.Memory.Delete(legacy.ID); !errors.Is(err, models.ErrLegacyDecisionMemoryWrite) {
		t.Fatalf("legacy delete error = %v", err)
	}
	if _, err := store.Memory.PromotePersistent(legacy.ID); !errors.Is(err, models.ErrLegacyDecisionMemoryWrite) {
		t.Fatalf("legacy promote error = %v", err)
	}

	reclassified := &models.MemoryEntry{
		ID: "legacy-reclassify", Title: "Historical convention", Layer: models.MemoryLayerProject,
		Category: "decision", Status: models.MemoryStatusActive, Content: "Historical convention.",
		CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}
	seedLegacyDecisionMemory(t, store, reclassified)
	reclassified.Category = "convention"
	if err := store.Memory.Update(reclassified); err != nil {
		t.Fatalf("reclassify legacy memory: %v", err)
	}
}

func TestMemoryStoreRejectsUnsafeIDs(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	store := NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("memory-id-security"); err != nil {
		t.Fatal(err)
	}

	for _, id := range []string{"../escape", `..\escape`, "nested/id", `C:\escape`, "name:stream"} {
		if err := store.Memory.Create(&models.MemoryEntry{ID: id, Title: "Unsafe", Category: "pattern"}); err == nil {
			t.Errorf("Create ID %q succeeded, want validation error", id)
		}
		if _, err := store.Memory.Get(id); err == nil {
			t.Errorf("Get ID %q succeeded, want validation error", id)
		}
		if err := store.Memory.Delete(id); err == nil {
			t.Errorf("Delete ID %q succeeded, want validation error", id)
		}
	}
}

func seedLegacyDecisionMemory(t *testing.T, store *Store, entry *models.MemoryEntry) {
	t.Helper()
	dir := filepath.Join(store.Root, "memory")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir legacy memory dir: %v", err)
	}
	path := filepath.Join(dir, models.MemoryFileName(entry.ID))
	if err := os.WriteFile(path, []byte(renderMemory(entry)), 0o644); err != nil {
		t.Fatalf("seed legacy memory: %v", err)
	}
}

func TestParseMemoryContentDefaultsLegacyLifecycle(t *testing.T) {
	content := `---
id: legacy1
title: Legacy Memory
layer: project
category: decision
createdAt: '2026-01-01T00:00:00.000Z'
updatedAt: '2026-01-02T00:00:00.000Z'
---

Legacy body.
`
	entry, err := parseMemoryContent(content, models.MemoryLayerProject)
	if err != nil {
		t.Fatalf("parseMemoryContent: %v", err)
	}
	if entry.Status != models.MemoryStatusActive {
		t.Fatalf("Status = %q, want %q", entry.Status, models.MemoryStatusActive)
	}
	wantMissing := []string{"status", "confidence", "lastVerified", "ttlDays", "sources"}
	if !reflect.DeepEqual(entry.LifecycleMetadataMissing, wantMissing) {
		t.Fatalf("LifecycleMetadataMissing = %#v, want %#v", entry.LifecycleMetadataMissing, wantMissing)
	}
	if entry.Content != "Legacy body." {
		t.Fatalf("Content = %q", entry.Content)
	}
}

func TestParseMemoryContentDefaultsNoFrontmatterLifecycle(t *testing.T) {
	entry, err := parseMemoryContent("Legacy body.", models.MemoryLayerProject)
	if err != nil {
		t.Fatalf("parseMemoryContent: %v", err)
	}
	if entry.Status != models.MemoryStatusActive {
		t.Fatalf("Status = %q, want %q", entry.Status, models.MemoryStatusActive)
	}
	wantMissing := []string{"status", "confidence", "lastVerified", "ttlDays", "sources"}
	if !reflect.DeepEqual(entry.LifecycleMetadataMissing, wantMissing) {
		t.Fatalf("LifecycleMetadataMissing = %#v, want %#v", entry.LifecycleMetadataMissing, wantMissing)
	}
	if entry.Content != "Legacy body." {
		t.Fatalf("Content = %q", entry.Content)
	}
}

func TestMemoryStoreListLoadsLegacyLifecycle(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	root := filepath.Join(t.TempDir(), ".knowns")
	memoryDir := filepath.Join(root, "memory")
	if err := os.MkdirAll(memoryDir, 0o755); err != nil {
		t.Fatalf("mkdir memory dir: %v", err)
	}
	content := `---
id: legacy1
title: Legacy Memory
layer: project
createdAt: '2026-01-01T00:00:00.000Z'
updatedAt: '2026-01-02T00:00:00.000Z'
---

Legacy body.
`
	if err := os.WriteFile(filepath.Join(memoryDir, "memory-legacy1.md"), []byte(content), 0o644); err != nil {
		t.Fatalf("write memory file: %v", err)
	}
	store := NewStore(root)
	entries, err := store.Memory.ListLocal()
	if err != nil {
		t.Fatalf("ListLocal: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("len(entries) = %d, want 1", len(entries))
	}
	if entries[0].Status != models.MemoryStatusActive {
		t.Fatalf("Status = %q, want %q", entries[0].Status, models.MemoryStatusActive)
	}
}

func TestRenderMemoryLifecycleRoundTrip(t *testing.T) {
	lastVerified := time.Date(2026, 6, 18, 4, 0, 0, 0, time.UTC)
	entry := &models.MemoryEntry{
		ID:             "life1",
		Title:          "Lifecycle Memory",
		Layer:          models.MemoryLayerProject,
		Category:       "pattern",
		Status:         models.MemoryStatusMerged,
		Confidence:     models.MemoryConfidenceHigh,
		LastVerified:   lastVerified,
		TTLDays:        90,
		Sources:        []string{"@doc/specs/memory", "@task-abc123"},
		MergedInto:     "target1",
		RejectedReason: "duplicate",
		Tags:           []string{"memory"},
		CreatedAt:      lastVerified,
		UpdatedAt:      lastVerified,
		Content:        "Body",
	}
	rendered := renderMemory(entry)
	for _, want := range []string{
		"status: merged",
		"confidence: high",
		"lastVerified: '2026-06-18T04:00:00.000Z'",
		"ttlDays: 90",
		"sources:",
		"  - '@doc/specs/memory'",
		"mergedInto: target1",
		"rejectedReason: duplicate",
	} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("rendered memory missing %q:\n%s", want, rendered)
		}
	}
	parsed, err := parseMemoryContent(rendered, models.MemoryLayerProject)
	if err != nil {
		t.Fatalf("parse rendered memory: %v", err)
	}
	if parsed.Status != entry.Status || parsed.Confidence != entry.Confidence {
		t.Fatalf("parsed lifecycle = %q/%q", parsed.Status, parsed.Confidence)
	}
	if !parsed.LastVerified.Equal(lastVerified) {
		t.Fatalf("LastVerified = %s, want %s", parsed.LastVerified, lastVerified)
	}
	if parsed.TTLDays != entry.TTLDays {
		t.Fatalf("TTLDays = %d, want %d", parsed.TTLDays, entry.TTLDays)
	}
	if !reflect.DeepEqual(parsed.Sources, entry.Sources) {
		t.Fatalf("Sources = %#v, want %#v", parsed.Sources, entry.Sources)
	}
}
