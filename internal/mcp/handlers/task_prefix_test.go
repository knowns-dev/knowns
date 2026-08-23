package handlers

import (
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/storage"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// recordingToolRegistrar captures the registered tool definition so the
// advertised schema can be asserted.
type recordingToolRegistrar struct {
	taskTool *mcp.Tool
}

func (r *recordingToolRegistrar) AddTool(tool mcp.Tool, _ server.ToolHandlerFunc) {
	if tool.Name == "tasks" {
		copied := tool
		r.taskTool = &copied
	}
}

func (r *recordingToolRegistrar) RegisterHelp(string, HelpEntry) {}

func newMCPPrefixStore(t *testing.T, defaultPrefix string) func() *storage.Store {
	t.Helper()
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("mcp-task-prefix"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	if defaultPrefix != "" {
		project, err := store.Config.Load()
		if err != nil {
			t.Fatalf("load config: %v", err)
		}
		project.Settings.DefaultTaskIDPrefix = defaultPrefix
		if err := store.Config.Save(project); err != nil {
			t.Fatalf("save config: %v", err)
		}
	}
	return func() *storage.Store { return store }
}

func mcpCreatedTaskID(t *testing.T, getStore func() *storage.Store, args map[string]any) string {
	t.Helper()
	result, err := handleTaskCreate(getStore, mutationRequest(args))
	if err != nil {
		t.Fatalf("handleTaskCreate: %v", err)
	}
	summary := mutationResultMap(t, result)
	if success, _ := summary["success"].(bool); !success {
		t.Fatalf("create was not successful: %#v", summary)
	}
	id, _ := summary["taskId"].(string)
	if id == "" {
		t.Fatalf("no taskId in response: %#v", summary)
	}
	return id
}

func TestMCPTaskCreateUsesProjectDefaultPrefix(t *testing.T) {
	getStore := newMCPPrefixStore(t, "KN")
	id := mcpCreatedTaskID(t, getStore, map[string]any{"title": "Default prefix"})
	if !regexp.MustCompile(`^KN-[0-9A-HJKMNP-TV-Z]{6}$`).MatchString(id) {
		t.Fatalf("task ID = %q, want KN-XXXXXX", id)
	}
	if _, err := getStore().Tasks.Get(id); err != nil {
		t.Fatalf("get created task %q: %v", id, err)
	}
}

func TestMCPTaskCreateHonorsCustomPrefixWithoutMutatingConfig(t *testing.T) {
	getStore := newMCPPrefixStore(t, "KN")
	id := mcpCreatedTaskID(t, getStore, map[string]any{"title": "Custom prefix", "prefix": "fr"})
	if !strings.HasPrefix(id, "FR-") {
		t.Fatalf("task ID = %q, want FR prefix", id)
	}

	project, err := getStore().Config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if project.Settings.DefaultTaskIDPrefix != "KN" {
		t.Fatalf("custom prefix mutated project default to %q", project.Settings.DefaultTaskIDPrefix)
	}
}

func TestMCPTaskCreateRejectsInvalidPrefix(t *testing.T) {
	getStore := newMCPPrefixStore(t, "")
	result, err := handleTaskCreate(getStore, mutationRequest(map[string]any{
		"title":  "Invalid prefix",
		"prefix": "1bad",
	}))
	if err != nil {
		t.Fatalf("handleTaskCreate returned transport error: %v", err)
	}
	if !result.IsError {
		t.Fatalf("invalid prefix did not produce an error result: %#v", result)
	}
	tasks, err := getStore().Tasks.List()
	if err != nil {
		t.Fatalf("list tasks: %v", err)
	}
	if len(tasks) != 0 {
		t.Fatalf("rejected create wrote %d tasks, want 0", len(tasks))
	}
}

func TestMCPTaskCreateFallsBackToLegacyIDs(t *testing.T) {
	getStore := newMCPPrefixStore(t, "")
	id := mcpCreatedTaskID(t, getStore, map[string]any{"title": "Legacy id"})
	if !regexp.MustCompile(`^[0-9a-z]{6}$`).MatchString(id) {
		t.Fatalf("task ID = %q, want legacy six-character base36 format", id)
	}
}

// The tool schema must advertise prefix, otherwise agents cannot discover it.
func TestMCPTaskToolAdvertisesPrefixParameter(t *testing.T) {
	getStore := newMCPPrefixStore(t, "")
	registrar := &recordingToolRegistrar{}
	RegisterTaskTool(registrar, getStore)
	if registrar.taskTool == nil {
		t.Fatal("tasks tool was not registered")
	}
	schema := registrar.taskTool.InputSchema.Properties
	if _, ok := schema["prefix"]; !ok {
		t.Fatalf("tasks tool schema has no prefix property: %v", schema)
	}
}
