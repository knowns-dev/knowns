package handlers

import (
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/memoryreview"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/mark3labs/mcp-go/mcp"
)

func TestMemoryAddNoMatchCreatesProposed(t *testing.T) {
	store := setupMemoryCleanupStore(t)
	text := callMemoryAdd(t, store, map[string]any{
		"action":   "add",
		"title":    "Unique memory",
		"category": "decision",
		"content":  "Use proposed status for new memory review.",
	})
	var entry models.MemoryEntry
	if err := json.Unmarshal([]byte(text), &entry); err != nil {
		t.Fatalf("unmarshal add output: %v\n%s", err, text)
	}
	if entry.Status != models.MemoryStatusProposed {
		t.Fatalf("status = %q, want proposed", entry.Status)
	}
	listText := callMemoryList(t, store, map[string]any{"action": "list"})
	var summaries []map[string]any
	if err := json.Unmarshal([]byte(listText), &summaries); err != nil {
		t.Fatalf("unmarshal list output: %v\n%s", err, listText)
	}
	if len(summaries) != 0 {
		t.Fatalf("default list should exclude proposed memory, got %+v", summaries)
	}
}

func TestMemoryAddDuplicateReturnsReviewRequiredAndNoWrite(t *testing.T) {
	store := setupMemoryCleanupStore(t)
	createMemoryForCleanupTest(t, store, "active1", models.MemoryLayerProject, time.Now().UTC(), time.Now().UTC())
	existing, err := store.Memory.Get("active1")
	if err != nil {
		t.Fatalf("get existing: %v", err)
	}
	existing.Title = "Default vector database"
	existing.Category = "decision"
	existing.Content = "Use Qdrant as the default vector database."
	existing.Status = models.MemoryStatusActive
	if err := store.Memory.Update(existing); err != nil {
		t.Fatalf("update existing: %v", err)
	}

	before := len(callMemoryCleanupListPersistent(t, store))
	text := callMemoryAdd(t, store, map[string]any{
		"action":   "add",
		"title":    "Default vector database",
		"category": "decision",
		"content":  "Use Qdrant as the default vector database.",
	})
	var result memoryreview.Result
	if err := json.Unmarshal([]byte(text), &result); err != nil {
		t.Fatalf("unmarshal review output: %v\n%s", err, text)
	}
	if result.Status != memoryreview.ResultReviewRequired {
		t.Fatalf("status = %q, want review_required", result.Status)
	}
	if len(result.Matches) != 1 || result.Matches[0].ID != "active1" {
		t.Fatalf("matches = %+v", result.Matches)
	}
	if after := len(callMemoryCleanupListPersistent(t, store)); after != before {
		t.Fatalf("memory count changed on review: before=%d after=%d", before, after)
	}
}

func TestMemoryCleanupDefaultsReturnStaleMemories(t *testing.T) {
	store := setupMemoryCleanupStore(t)
	now := time.Now().UTC()
	createMemoryForCleanupTest(t, store, "old001", models.MemoryLayerProject, now.AddDate(0, 0, -10), now.AddDate(0, 0, -10))
	createMemoryForCleanupTest(t, store, "new001", models.MemoryLayerProject, now.AddDate(0, 0, -1), now.AddDate(0, 0, -1))

	candidates := callMemoryCleanup(t, store, map[string]any{"action": "cleanup"})
	if len(candidates) != 1 {
		t.Fatalf("expected 1 candidate, got %d: %+v", len(candidates), candidates)
	}
	if candidates[0].ID != "old001" || candidates[0].Content == "" || candidates[0].AgeDays < 9 {
		t.Fatalf("unexpected candidate: %+v", candidates[0])
	}
}

func TestMemoryCleanupCustomThresholdLayerLimitAndSorting(t *testing.T) {
	store := setupMemoryCleanupStore(t)
	now := time.Now().UTC()
	createMemoryForCleanupTest(t, store, "proj01", models.MemoryLayerProject, now.AddDate(0, 0, -40), now.AddDate(0, 0, -40))
	createMemoryForCleanupTest(t, store, "glob01", models.MemoryLayerGlobal, now.AddDate(0, 0, -30), now.AddDate(0, 0, -30))
	createMemoryForCleanupTest(t, store, "glob02", models.MemoryLayerGlobal, now.AddDate(0, 0, -50), now.AddDate(0, 0, -50))
	createMemoryForCleanupTest(t, store, "glob03", models.MemoryLayerGlobal, now.AddDate(0, 0, -10), now.AddDate(0, 0, -10))

	candidates := callMemoryCleanup(t, store, map[string]any{
		"action":        "cleanup",
		"layer":         models.MemoryLayerGlobal,
		"olderThanDays": 14,
		"limit":         1,
	})
	if len(candidates) != 1 {
		t.Fatalf("expected 1 candidate, got %d", len(candidates))
	}
	if candidates[0].ID != "glob02" {
		t.Fatalf("expected oldest global memory first, got %+v", candidates[0])
	}
}

func TestMemoryCleanupEmptyWhenNoStaleMemories(t *testing.T) {
	store := setupMemoryCleanupStore(t)
	now := time.Now().UTC()
	createMemoryForCleanupTest(t, store, "new001", models.MemoryLayerProject, now.AddDate(0, 0, -1), now.AddDate(0, 0, -1))

	candidates := callMemoryCleanup(t, store, map[string]any{"action": "cleanup"})
	if len(candidates) != 0 {
		t.Fatalf("expected no candidates, got %+v", candidates)
	}
}

func TestMemoryUpdateTouchRemovesEntryFromCleanup(t *testing.T) {
	store := setupMemoryCleanupStore(t)
	now := time.Now().UTC()
	createMemoryForCleanupTest(t, store, "old001", models.MemoryLayerProject, now.AddDate(0, 0, -10), now.AddDate(0, 0, -10))

	before, err := store.Memory.Get("old001")
	if err != nil {
		t.Fatalf("get before: %v", err)
	}
	updated, err := handleMemoryUpdate(func() *storage.Store { return store }, mcp.CallToolRequest{Params: mcp.CallToolParams{Arguments: map[string]any{"action": "update", "id": "old001"}}})
	if err != nil || updated.IsError {
		t.Fatalf("update returned error: %v, result: %+v", err, updated)
	}
	after, err := store.Memory.Get("old001")
	if err != nil {
		t.Fatalf("get after: %v", err)
	}
	if !after.UpdatedAt.After(before.UpdatedAt) {
		t.Fatalf("expected updatedAt to advance, before=%s after=%s", before.UpdatedAt, after.UpdatedAt)
	}
	candidates := callMemoryCleanup(t, store, map[string]any{"action": "cleanup"})
	if len(candidates) != 0 {
		t.Fatalf("expected touched memory to be excluded, got %+v", candidates)
	}
}

func setupMemoryCleanupStore(t *testing.T) *storage.Store {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("memory-cleanup-test"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	return store
}

func createMemoryForCleanupTest(t *testing.T, store *storage.Store, id, layer string, createdAt, updatedAt time.Time) {
	t.Helper()
	if err := store.Memory.Create(&models.MemoryEntry{
		ID:        id,
		Title:     "Memory " + id,
		Layer:     layer,
		Category:  "pattern",
		Tags:      []string{"cleanup"},
		Content:   "Content for " + id,
		CreatedAt: createdAt,
		UpdatedAt: updatedAt,
	}); err != nil {
		t.Fatalf("create memory %s: %v", id, err)
	}
}

func callMemoryCleanup(t *testing.T, store *storage.Store, args map[string]any) []memoryCleanupCandidate {
	t.Helper()
	result, err := handleMemoryCleanup(func() *storage.Store { return store }, mcp.CallToolRequest{Params: mcp.CallToolParams{Arguments: args}})
	if err != nil || result.IsError {
		t.Fatalf("cleanup returned error: %v, result: %+v", err, result)
	}
	if len(result.Content) != 1 {
		t.Fatalf("expected one content item, got %d", len(result.Content))
	}
	text, ok := result.Content[0].(mcp.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", result.Content[0])
	}
	var candidates []memoryCleanupCandidate
	if err := json.Unmarshal([]byte(text.Text), &candidates); err != nil {
		t.Fatalf("unmarshal cleanup output: %v\n%s", err, text.Text)
	}
	return candidates
}

func callMemoryAdd(t *testing.T, store *storage.Store, args map[string]any) string {
	t.Helper()
	result, err := handleMemoryAdd(func() *storage.Store { return store }, mcp.CallToolRequest{Params: mcp.CallToolParams{Arguments: args}})
	if err != nil || result.IsError {
		t.Fatalf("add returned error: %v, result: %+v", err, result)
	}
	return callMemoryTextResult(t, result)
}

func callMemoryList(t *testing.T, store *storage.Store, args map[string]any) string {
	t.Helper()
	result, err := handleMemoryList(func() *storage.Store { return store }, mcp.CallToolRequest{Params: mcp.CallToolParams{Arguments: args}})
	if err != nil || result.IsError {
		t.Fatalf("list returned error: %v, result: %+v", err, result)
	}
	return callMemoryTextResult(t, result)
}

func callMemoryTextResult(t *testing.T, result *mcp.CallToolResult) string {
	t.Helper()
	if len(result.Content) != 1 {
		t.Fatalf("expected one content item, got %d", len(result.Content))
	}
	text, ok := result.Content[0].(mcp.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", result.Content[0])
	}
	return text.Text
}

func callMemoryCleanupListPersistent(t *testing.T, store *storage.Store) []*models.MemoryEntry {
	t.Helper()
	entries, err := store.Memory.ListPersistent("")
	if err != nil {
		t.Fatalf("list persistent memories: %v", err)
	}
	return entries
}
