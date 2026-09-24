package handlers

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/mark3labs/mcp-go/mcp"
)

// deletedTaskStore returns a store holding one Task whose file was removed and
// tombstoned by reconciliation, the state a real deletion leaves behind.
func deletedTaskStore(t *testing.T, id string) (*storage.Store, string) {
	t.Helper()
	ctx := t.Context()
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("mcp-restore"); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := store.Tasks.Create(&models.Task{ID: id, Title: "Gone", Status: "todo", Priority: "medium", CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	files, _ := filepath.Glob(filepath.Join(store.Root, "tasks", "*.md"))
	if len(files) != 1 {
		t.Fatalf("task files = %v, want exactly one", files)
	}
	r, err := storage.NewFilesystemReconciler(store.Root)
	if err != nil {
		t.Fatal(err)
	}
	clock := now
	r.SetLifecycleClock(func() time.Time { return clock })
	if _, err := r.ReconcileLifecycle(ctx, true); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(files[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := r.ReconcileLifecycle(ctx, true); err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(storage.ReconcileQuietWindow)
	if _, err := r.ReconcileLifecycle(ctx, true); err != nil {
		t.Fatal(err)
	}
	return store, files[0]
}

func callTaskRestore(t *testing.T, store *storage.Store, args map[string]any) (map[string]any, bool) {
	t.Helper()
	args["action"] = "restore"
	result, err := handleTaskRestore(t.Context(), func() *storage.Store { return store }, mcp.CallToolRequest{Params: mcp.CallToolParams{Arguments: args}})
	if err != nil {
		t.Fatal(err)
	}
	var text string
	for _, content := range result.Content {
		if item, ok := content.(mcp.TextContent); ok {
			text = item.Text
		}
	}
	var payload map[string]any
	if !result.IsError {
		if err := json.Unmarshal([]byte(text), &payload); err != nil {
			t.Fatalf("decode %q: %v", text, err)
		}
	}
	return payload, result.IsError
}

func TestTasksRestorePreviewsThenReactivatesADeletedTask(t *testing.T) {
	store, file := deletedTaskStore(t, "gone")

	preview, isErr := callTaskRestore(t, store, map[string]any{"taskId": "gone"})
	if isErr {
		t.Fatal("preview returned an error")
	}
	plan, _ := preview["plan"].(map[string]any)
	if preview["execute"] != false || plan["tombstoned"] != true || plan["filePresent"] != false {
		t.Fatalf("preview = %+v, want a tombstoned Task with no file", preview)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("preview recreated the file: %v", err)
	}

	executed, isErr := callTaskRestore(t, store, map[string]any{"taskId": "gone", "execute": true})
	if isErr || executed["restored"] != true {
		t.Fatalf("execute = %+v error=%t, want restored", executed, isErr)
	}
	if _, err := os.Stat(file); err != nil {
		t.Fatalf("restore did not bring the file back: %v", err)
	}
	task, err := store.Tasks.Get("gone")
	if err != nil || task.Title != "Gone" {
		t.Fatalf("restored task = %+v err=%v", task, err)
	}

	if _, isErr := callTaskRestore(t, store, map[string]any{"taskId": "gone", "execute": true}); !isErr {
		t.Fatal("restoring a live Task must be an MCP error result")
	}
}

func TestDocsRestoreWithoutRevisionReactivatesADeletedDoc(t *testing.T) {
	ctx := t.Context()
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("mcp-doc-restore"); err != nil {
		t.Fatal(err)
	}
	if err := store.MutateDocWithHistory(ctx, nil, &models.Doc{Path: "guides/gone", Title: "Gone", Content: "## One\nkept"}, storage.DocMutationOptions{Actor: "test", Source: "test"}); err != nil {
		t.Fatal(err)
	}
	current, err := store.Docs.Get("guides/gone")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteDocWithExpectedHash(ctx, "guides/gone", storage.DocDeleteOptions{ExpectedHash: storage.CanonicalDocHash(current), Actor: "test", Source: "test"}); err != nil {
		t.Fatal(err)
	}
	restoreArgs := func() mcp.CallToolRequest {
		return mcp.CallToolRequest{Params: mcp.CallToolParams{Arguments: map[string]any{"action": "restore", "path": "guides/gone"}}}
	}
	result, err := handleDocRestore(func() *storage.Store { return store }, restoreArgs())
	if err != nil || result.IsError {
		t.Fatalf("restore without revision: result=%+v err=%v", result, err)
	}
	restored, err := store.Docs.Get("guides/gone")
	if err != nil || restored.Content != "## One\nkept" {
		t.Fatalf("restored Doc = %+v err=%v", restored, err)
	}

	// On a live Doc, omitting the revision is still an error, now with a hint.
	result, err = handleDocRestore(func() *storage.Store { return store }, restoreArgs())
	if err != nil || !result.IsError {
		t.Fatalf("restore of a live Doc without revision: result=%+v err=%v", result, err)
	}
	var text string
	for _, content := range result.Content {
		if item, ok := content.(mcp.TextContent); ok {
			text = item.Text
		}
	}
	if !strings.Contains(text, "pass revision") {
		t.Fatalf("error text = %q, want a hint to pass revision", text)
	}
}
