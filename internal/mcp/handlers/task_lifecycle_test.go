package handlers

import (
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/permissions"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/howznguyen/knowns/internal/tasklifecycle"
	"github.com/mark3labs/mcp-go/mcp"
	mcpserver "github.com/mark3labs/mcp-go/server"
)

func TestTaskLifecycleMCPContractAndTrustedPermission(t *testing.T) {
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("mcp"); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	completed := now.Add(-time.Hour)
	if err := store.Tasks.Create(&models.Task{ID: "mcp-life", Title: "mcp-life", Status: "done", Priority: "medium", CreatedAt: now.Add(-2 * time.Hour), UpdatedAt: completed, CompletedAt: &completed}); err != nil {
		t.Fatal(err)
	}

	preview := callTaskLifecycleMCP(t, store, "batch_archive", map[string]any{"ids": []any{"mcp-life"}})
	if preview.Execute || !preview.Completed || preview.Processed != 1 || preview.Changed != 0 || !preview.Items[0].Eligible || preview.Items[0].CompletedAt == nil {
		t.Fatalf("preview = %+v", preview)
	}
	executed := callTaskLifecycleMCP(t, store, "batch_archive", map[string]any{"ids": []any{"mcp-life"}, "execute": true})
	if !executed.Execute || executed.Changed != 1 || executed.Items[0].After != models.TaskLifecycleArchived || executed.Items[0].Event == nil {
		t.Fatalf("execute = %+v", executed)
	}
	idempotent := callTaskLifecycleMCP(t, store, "batch_archive", map[string]any{"ids": []any{"mcp-life"}, "execute": true})
	if !idempotent.Completed || idempotent.Changed != 0 || len(idempotent.Items[0].Reasons) != 1 || idempotent.Items[0].Reasons[0].Code != tasklifecycle.ReasonAlreadyArchived {
		t.Fatalf("idempotent archive = %+v", idempotent)
	}
	callTaskLifecycleMCP(t, store, "unarchive", map[string]any{"taskId": "mcp-life", "execute": true})
	alreadyActive := callTaskLifecycleMCP(t, store, "unarchive", map[string]any{"taskId": "mcp-life"})
	if alreadyActive.Items[0].Eligible || alreadyActive.Items[0].Reasons[0].Code != tasklifecycle.ReasonAlreadyActive {
		t.Fatalf("active unarchive preview = %+v", alreadyActive)
	}
	empty, emptyError := callTaskLifecycleMCPAny(t, store, "batch_unarchive", map[string]any{})
	if !emptyError || empty.Items[0].Reasons[0].Code != tasklifecycle.ReasonInvalidRequest {
		t.Fatalf("empty batch-unarchive = %+v error=%t", empty, emptyError)
	}

	// A spoofed request argument cannot grant a permission absent from config.
	denied, isError := callTaskLifecycleMCPAny(t, store, "hard_delete", map[string]any{"taskId": "mcp-life", "confirmed": true, "reason": "spoof", "authorized": true})
	if !isError {
		t.Fatal("denied hard-delete must be an MCP error result")
	}
	if denied.Completed || len(denied.Items) != 1 || denied.Items[0].Reasons[0].Code != tasklifecycle.ReasonPermissionRequired {
		t.Fatalf("denied = %+v", denied)
	}
	if _, err := store.Tasks.Get("mcp-life"); err != nil {
		t.Fatalf("spoof deleted Task: %v", err)
	}

	config, err := store.Config.Load()
	if err != nil {
		t.Fatal(err)
	}
	config.Settings.Permissions = &permissions.PermissionConfig{Preset: permissions.PresetReadWrite}
	if err := store.Config.Save(config); err != nil {
		t.Fatal(err)
	}
	missingIntent, intentError := callTaskLifecycleMCPAny(t, store, "hard_delete", map[string]any{"taskId": "mcp-life"})
	if !intentError || missingIntent.Items[0].Reasons[0].Code != tasklifecycle.ReasonConfirmationRequired {
		t.Fatalf("missing hard-delete intent = %+v error=%t", missingIntent, intentError)
	}
	deleted := callTaskLifecycleMCP(t, store, "hard_delete", map[string]any{"taskId": "mcp-life", "confirmed": true, "reason": "policy-approved"})
	if !deleted.Completed || deleted.Changed != 1 {
		t.Fatalf("deleted = %+v", deleted)
	}
	if _, err := store.Tasks.Get("mcp-life"); err == nil {
		t.Fatal("hard-delete left Task")
	}
	conflict, conflictError := callTaskLifecycleMCPAny(t, store, "hard_delete", map[string]any{"taskId": "mcp-life", "confirmed": true, "reason": "different"})
	if !conflictError || conflict.Items[0].Reasons[0].Code != tasklifecycle.ReasonTombstoneConflict {
		t.Fatalf("tombstone conflict = %+v error=%t", conflict, conflictError)
	}
}

func TestRegisteredTaskLifecycleMCPMiddlewarePreservesSharedResponse(t *testing.T) {
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("registered-mcp"); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := store.Tasks.Create(&models.Task{ID: "registered-life", Title: "registered", Status: "todo", Priority: "medium", CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	registered := &registeredTaskLifecycleServer{MCPServer: mcpserver.NewMCPServer(
		"registered-test", "test",
		mcpserver.WithToolHandlerMiddleware(permissions.NewGuardMiddleware(func() *permissions.PermissionConfig {
			config, err := store.Config.Load()
			if err != nil {
				return nil
			}
			return config.Settings.Permissions
		})),
	)}
	RegisterTaskTool(registered, func() *storage.Store { return store })

	denied, isError := callRegisteredTaskLifecycleMCP(t, registered.MCPServer, map[string]any{
		"action": "hard_delete", "taskId": "registered-life", "confirmed": true, "reason": "spoof", "authorized": true,
	})
	if !isError || denied.Items[0].Reasons[0].Code != tasklifecycle.ReasonPermissionRequired {
		t.Fatalf("registered denial = %+v error=%t", denied, isError)
	}

	config, err := store.Config.Load()
	if err != nil {
		t.Fatal(err)
	}
	config.Settings.Permissions = &permissions.PermissionConfig{Preset: permissions.PresetReadOnly}
	if err := store.Config.Save(config); err != nil {
		t.Fatal(err)
	}
	archiveDenied, isError := callRegisteredTaskLifecycleMCP(t, registered.MCPServer, map[string]any{"action": "archive", "taskId": "registered-life", "execute": true})
	if !isError || archiveDenied.Items[0].Reasons[0].Code != tasklifecycle.ReasonPermissionRequired {
		t.Fatalf("registered archive denial = %+v error=%t", archiveDenied, isError)
	}
	config.Settings.Permissions = &permissions.PermissionConfig{Preset: permissions.PresetReadWrite}
	if err := store.Config.Save(config); err != nil {
		t.Fatal(err)
	}
	missing, isError := callRegisteredTaskLifecycleMCP(t, registered.MCPServer, map[string]any{"action": "hard_delete", "taskId": "registered-life"})
	if !isError || missing.Items[0].Reasons[0].Code != tasklifecycle.ReasonConfirmationRequired {
		t.Fatalf("registered intent error = %+v error=%t", missing, isError)
	}
}

type registeredTaskLifecycleServer struct {
	*mcpserver.MCPServer
}

func (*registeredTaskLifecycleServer) RegisterHelp(string, HelpEntry) {}

func callRegisteredTaskLifecycleMCP(t *testing.T, server *mcpserver.MCPServer, args map[string]any) (tasklifecycle.Response, bool) {
	t.Helper()
	message, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "tools/call",
		"params": map[string]any{"name": "tasks", "arguments": args},
	})
	if err != nil {
		t.Fatal(err)
	}
	result := server.HandleMessage(t.Context(), message)
	data, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	var envelope struct {
		Result struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
			IsError bool `json:"isError"`
		} `json:"result"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil || len(envelope.Result.Content) == 0 {
		t.Fatalf("decode registered result %s: %v", data, err)
	}
	var response tasklifecycle.Response
	if err := json.Unmarshal([]byte(envelope.Result.Content[0].Text), &response); err != nil {
		t.Fatalf("decode shared response %q: %v", envelope.Result.Content[0].Text, err)
	}
	return response, envelope.Result.IsError
}

func callTaskLifecycleMCP(t *testing.T, store *storage.Store, action string, args map[string]any) tasklifecycle.Response {
	t.Helper()
	response, isError := callTaskLifecycleMCPAny(t, store, action, args)
	if isError {
		t.Fatalf("%s returned error response: %+v", action, response)
	}
	return response
}

func callTaskLifecycleMCPAny(t *testing.T, store *storage.Store, action string, args map[string]any) (tasklifecycle.Response, bool) {
	t.Helper()
	args["action"] = action
	result, err := handleTaskLifecycle(t.Context(), func() *storage.Store { return store }, action, mcp.CallToolRequest{Params: mcp.CallToolParams{Arguments: args}})
	if err != nil {
		t.Fatalf("%s: %v", action, err)
	}
	if result == nil {
		t.Fatalf("%s result = %+v", action, result)
	}
	var text string
	for _, content := range result.Content {
		if item, ok := content.(mcp.TextContent); ok {
			text = item.Text
			break
		}
	}
	var response tasklifecycle.Response
	if err := json.Unmarshal([]byte(text), &response); err != nil {
		t.Fatalf("decode %s: %v", text, err)
	}
	return response, result.IsError
}
