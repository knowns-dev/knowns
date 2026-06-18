package storage

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

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
		Category:       "decision",
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
