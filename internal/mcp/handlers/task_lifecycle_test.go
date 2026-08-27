package handlers

import (
	"encoding/json"
	"path/filepath"
	"strings"
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

	// A hard delete is denied by the permission layer, not by the arguments.
	// The spoofed "authorized" argument that used to be passed here is now
	// refused before dispatch by validateTaskArgs, which would hide whether the
	// permission check itself still holds, so it is asserted separately in
	// TestUnknownTaskArgumentIsRejected.
	denied, isError := callTaskLifecycleMCPAny(t, store, "hard_delete", map[string]any{"taskId": "mcp-life", "confirmed": true, "reason": "spoof"})
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

func TestMCPTaskLifecycleUsesBestEffortIndexing(t *testing.T) {
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("mcp-life-index"); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	completed := now.Add(-time.Hour)
	if err := store.Tasks.Create(&models.Task{ID: "life-index", Title: "life-index", Status: "done", Priority: "medium", CreatedAt: now.Add(-2 * time.Hour), UpdatedAt: completed, CompletedAt: &completed}); err != nil {
		t.Fatal(err)
	}
	config, err := store.Config.Load()
	if err != nil {
		t.Fatal(err)
	}
	config.Settings.Permissions = &permissions.PermissionConfig{Preset: permissions.PresetReadWrite}
	if err := store.Config.Save(config); err != nil {
		t.Fatal(err)
	}

	oldIndex := mcpBestEffortIndexTask
	oldRemove := mcpBestEffortRemoveTask
	t.Cleanup(func() {
		mcpBestEffortIndexTask = oldIndex
		mcpBestEffortRemoveTask = oldRemove
	})

	var indexed []string
	var removed []string
	mcpBestEffortIndexTask = func(_ *storage.Store, id string) {
		indexed = append(indexed, id)
	}
	mcpBestEffortRemoveTask = func(_ *storage.Store, id string) {
		removed = append(removed, id)
	}

	archived := callTaskLifecycleMCP(t, store, "archive", map[string]any{"taskId": "life-index", "execute": true})
	if !archived.Completed || archived.Changed != 1 {
		t.Fatalf("archive = %+v", archived)
	}
	if len(indexed) != 1 || indexed[0] != "life-index" {
		t.Fatalf("indexed after archive = %#v, want [life-index]", indexed)
	}

	reopened := callTaskLifecycleMCP(t, store, "unarchive", map[string]any{"taskId": "life-index", "execute": true})
	if !reopened.Completed || reopened.Changed != 1 {
		t.Fatalf("unarchive = %+v", reopened)
	}
	if len(indexed) != 2 || indexed[1] != "life-index" {
		t.Fatalf("indexed after unarchive = %#v, want second life-index", indexed)
	}

	deleted := callTaskLifecycleMCP(t, store, "hard_delete", map[string]any{"taskId": "life-index", "confirmed": true, "reason": "index cleanup"})
	if !deleted.Completed || deleted.Changed != 1 {
		t.Fatalf("hard delete = %+v", deleted)
	}
	if len(removed) != 1 || removed[0] != "life-index" {
		t.Fatalf("removed after hard delete = %#v, want [life-index]", removed)
	}
}

func TestMCPBatchExpectedHashesRejectOnlyStaleItem(t *testing.T) {
	t.Run("archive", func(t *testing.T) {
		store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
		if err := store.Init("mcp-batch-archive"); err != nil {
			t.Fatal(err)
		}
		createMCPBatchTask(t, store, "batch-a-stale")
		createMCPBatchTask(t, store, "batch-b-other")
		stale, err := store.Tasks.Get("batch-a-stale")
		if err != nil {
			t.Fatal(err)
		}
		other, err := store.Tasks.Get("batch-b-other")
		if err != nil {
			t.Fatal(err)
		}
		staleExpected := stale.CanonicalHash
		otherExpected := other.CanonicalHash
		if _, err := tasklifecycle.New(store).UpdateTask(t.Context(), stale.ID, tasklifecycle.TaskUpdateOptions{Mutate: func(task *models.Task) error {
			task.Title = "mcp-batch-stale-secret-title"
			task.Description = "mcp-batch-stale-secret-description"
			return nil
		}}); err != nil {
			t.Fatal(err)
		}
		staleBefore, err := store.Tasks.Get(stale.ID)
		if err != nil {
			t.Fatal(err)
		}
		historyBefore, err := store.Versions.GetHistory(stale.ID)
		if err != nil {
			t.Fatal(err)
		}
		var indexed []string
		oldIndex := mcpBestEffortIndexTask
		mcpBestEffortIndexTask = func(_ *storage.Store, id string) { indexed = append(indexed, id) }
		t.Cleanup(func() { mcpBestEffortIndexTask = oldIndex })
		response, isError, raw := callTaskLifecycleMCPRaw(t, store, "batch_archive", map[string]any{
			"ids": []any{stale.ID, other.ID}, "execute": true,
			"expectedHashes": map[string]any{stale.ID: staleExpected, other.ID: otherExpected},
		})
		if !isError || !response.Completed || response.FailedTaskID != stale.ID || response.Changed != 1 {
			t.Fatalf("batch archive error=%t response=%+v", isError, response)
		}
		if len(response.Items) != 2 || response.Items[0].TaskID != stale.ID || response.Items[1].TaskID != other.ID {
			t.Fatalf("batch archive item order=%+v", response.Items)
		}
		if strings.Contains(raw, "mcp-batch-stale-secret-title") || strings.Contains(raw, "mcp-batch-stale-secret-description") {
			t.Fatalf("MCP conflict leaked stale content: %s", raw)
		}
		staleAfter, err := store.Tasks.Get(stale.ID)
		if err != nil || staleAfter.CanonicalHash != staleBefore.CanonicalHash || staleAfter.Title != staleBefore.Title {
			t.Fatalf("stale canonical changed: before=%#v after=%#v err=%v", staleBefore, staleAfter, err)
		}
		historyAfter, err := store.Versions.GetHistory(stale.ID)
		if err != nil || len(historyAfter.Versions) != len(historyBefore.Versions) {
			t.Fatalf("stale history changed: before=%d after=%d err=%v", len(historyBefore.Versions), len(historyAfter.Versions), err)
		}
		otherAfter, err := store.Tasks.Get(other.ID)
		if err != nil || !otherAfter.Archived {
			t.Fatalf("other Task was not archived: %#v err=%v", otherAfter, err)
		}
		if len(indexed) != 1 || indexed[0] != other.ID {
			t.Fatalf("index hooks=%v, want only successful other item", indexed)
		}
	})

	t.Run("unarchive", func(t *testing.T) {
		store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
		if err := store.Init("mcp-batch-unarchive"); err != nil {
			t.Fatal(err)
		}
		createMCPBatchTask(t, store, "batch-a-stale")
		createMCPBatchTask(t, store, "batch-b-other")
		service := tasklifecycle.New(store)
		for _, id := range []string{"batch-a-stale", "batch-b-other"} {
			if _, err := service.Archive(t.Context(), id, tasklifecycle.ArchiveOptions{}); err != nil {
				t.Fatal(err)
			}
		}
		stale, err := store.Tasks.Get("batch-a-stale")
		if err != nil {
			t.Fatal(err)
		}
		other, err := store.Tasks.Get("batch-b-other")
		if err != nil {
			t.Fatal(err)
		}
		staleExpected := stale.CanonicalHash
		otherExpected := other.CanonicalHash
		stale.Title = "mcp-batch-unarchive-secret-title"
		stale.Description = "mcp-batch-unarchive-secret-description"
		if err := store.Tasks.Update(stale); err != nil {
			t.Fatal(err)
		}
		staleBefore, err := store.Tasks.Get(stale.ID)
		if err != nil {
			t.Fatal(err)
		}
		historyBefore, err := store.Versions.GetHistory(stale.ID)
		if err != nil {
			t.Fatal(err)
		}
		var indexed []string
		oldIndex := mcpBestEffortIndexTask
		mcpBestEffortIndexTask = func(_ *storage.Store, id string) { indexed = append(indexed, id) }
		t.Cleanup(func() { mcpBestEffortIndexTask = oldIndex })
		response, isError, raw := callTaskLifecycleMCPRaw(t, store, "batch_unarchive", map[string]any{
			"ids": []any{stale.ID, other.ID}, "execute": true,
			"expectedHashes": map[string]any{stale.ID: staleExpected, other.ID: otherExpected},
		})
		if !isError || !response.Completed || response.FailedTaskID != stale.ID || response.Changed != 1 {
			t.Fatalf("batch unarchive error=%t response=%+v", isError, response)
		}
		if len(response.Items) != 2 || response.Items[0].TaskID != stale.ID || response.Items[1].TaskID != other.ID {
			t.Fatalf("batch unarchive item order=%+v", response.Items)
		}
		if strings.Contains(raw, "mcp-batch-unarchive-secret-title") || strings.Contains(raw, "mcp-batch-unarchive-secret-description") {
			t.Fatalf("MCP conflict leaked stale content: %s", raw)
		}
		staleAfter, err := store.Tasks.Get(stale.ID)
		if err != nil || staleAfter.CanonicalHash != staleBefore.CanonicalHash || !staleAfter.Archived {
			t.Fatalf("stale canonical changed: before=%#v after=%#v err=%v", staleBefore, staleAfter, err)
		}
		historyAfter, err := store.Versions.GetHistory(stale.ID)
		if err != nil || len(historyAfter.Versions) != len(historyBefore.Versions) {
			t.Fatalf("stale history changed: before=%d after=%d err=%v", len(historyBefore.Versions), len(historyAfter.Versions), err)
		}
		otherAfter, err := store.Tasks.Get(other.ID)
		if err != nil || otherAfter.Archived {
			t.Fatalf("other Task was not unarchived: %#v err=%v", otherAfter, err)
		}
		if len(indexed) != 1 || indexed[0] != other.ID {
			t.Fatalf("index hooks=%v, want only successful other item", indexed)
		}
	})
}

func createMCPBatchTask(t *testing.T, store *storage.Store, id string) {
	t.Helper()
	now := time.Now().UTC()
	completed := now.Add(-time.Hour)
	if err := store.Tasks.Create(&models.Task{ID: id, Title: id, Status: "done", Priority: "medium", CreatedAt: now.Add(-2 * time.Hour), UpdatedAt: completed, CompletedAt: &completed}); err != nil {
		t.Fatal(err)
	}
}

func callTaskLifecycleMCPRaw(t *testing.T, store *storage.Store, action string, args map[string]any) (tasklifecycle.Response, bool, string) {
	t.Helper()
	result, err := handleTaskLifecycle(t.Context(), func() *storage.Store { return store }, action, mcp.CallToolRequest{Params: mcp.CallToolParams{Arguments: args}})
	if err != nil {
		t.Fatal(err)
	}
	if result == nil {
		t.Fatalf("%s result is nil", action)
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
	return response, result.IsError, text
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
		"action": "hard_delete", "taskId": "registered-life", "confirmed": true, "reason": "spoof",
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
