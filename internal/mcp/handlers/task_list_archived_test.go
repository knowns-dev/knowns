package handlers

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/mark3labs/mcp-go/mcp"
)

// An agent that archives a Task must still be able to read it back through
// list; hiding it by default is a view choice, not a deletion.
func TestHandleTaskListIncludeHistorical(t *testing.T) {
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("task-list-archived"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	for _, id := range []string{"activeone", "archivedone"} {
		if err := store.Tasks.Create(&models.Task{
			ID: id, Title: "Task " + id, Status: "done", Priority: "medium",
		}); err != nil {
			t.Fatalf("create %s: %v", id, err)
		}
	}
	if err := store.Tasks.Archive("archivedone"); err != nil {
		t.Fatalf("archive: %v", err)
	}

	getStore := func() *storage.Store { return store }
	call := func(args map[string]any) string {
		t.Helper()
		result, err := handleTaskList(getStore, mcp.CallToolRequest{Params: mcp.CallToolParams{Arguments: args}})
		if err != nil {
			t.Fatalf("handleTaskList: %v", err)
		}
		text, ok := result.Content[0].(mcp.TextContent)
		if !ok {
			t.Fatalf("unexpected content %#v", result.Content[0])
		}
		return text.Text
	}

	def := call(map[string]any{})
	if !strings.Contains(def, "activeone") {
		t.Errorf("default list missing active task: %s", def)
	}
	if strings.Contains(def, "archivedone") {
		t.Errorf("default list must hide archived task: %s", def)
	}

	withArchived := call(map[string]any{"includeHistorical": true})
	if !strings.Contains(withArchived, "activeone") || !strings.Contains(withArchived, "archivedone") {
		t.Errorf("includeHistorical list = %s, want both tasks", withArchived)
	}
}
