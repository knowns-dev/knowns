package handlers

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/howznguyen/knowns/internal/tasklifecycle"
	"github.com/mark3labs/mcp-go/mcp"
	mcpserver "github.com/mark3labs/mcp-go/server"
)

func TestParseMutationReturn(t *testing.T) {
	valid := []struct {
		name string
		args map[string]any
		want string
	}{
		{name: "omitted", args: map[string]any{}, want: mutationReturnSummary},
		{name: "summary", args: map[string]any{"return": mutationReturnSummary}, want: mutationReturnSummary},
		{name: "full", args: map[string]any{"return": mutationReturnFull}, want: mutationReturnFull},
	}
	for _, tt := range valid {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseMutationReturn(tt.args)
			if err != nil || got != tt.want {
				t.Fatalf("parseMutationReturn() = (%q, %v), want (%q, nil)", got, err, tt.want)
			}
		})
	}

	invalid := []any{"", "compact", 42, true}
	for _, value := range invalid {
		if _, err := parseMutationReturn(map[string]any{"return": value}); err == nil {
			t.Fatalf("parseMutationReturn(return=%#v) succeeded", value)
		}
	}
}

func TestRegisteredMutationToolsRejectInvalidReturn(t *testing.T) {
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("registered-mutation-response"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	server := &mutationTestServer{MCPServer: mcpserver.NewMCPServer("mutation-test", "test")}
	RegisterTaskTool(server, func() *storage.Store { return store })
	RegisterDocTool(server, func() *storage.Store { return store })

	for _, key := range []string{"tasks.create", "tasks.update", "docs.create", "docs.update"} {
		entry, ok := server.help[key]
		if !ok {
			t.Fatalf("help entry %q was not registered", key)
		}
		if got := entry.Params["return"]; !strings.Contains(got, mutationReturnSummary) || !strings.Contains(got, mutationReturnFull) {
			t.Fatalf("help entry %q return param = %q", key, got)
		}
	}

	for _, tt := range []struct {
		name string
		tool string
		args map[string]any
	}{
		{name: "task create", tool: "tasks", args: map[string]any{"action": "create", "title": "invalid task", "return": "compact"}},
		{name: "doc create", tool: "docs", args: map[string]any{"action": "create", "title": "invalid doc", "return": "compact"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			text, isError := callRegisteredMutationTool(t, server.MCPServer, tt.tool, tt.args)
			if !isError {
				t.Fatalf("registered call succeeded: %s", text)
			}
			if !strings.Contains(text, mutationReturnSummary) || !strings.Contains(text, mutationReturnFull) {
				t.Fatalf("registered mode error does not list valid values: %q", text)
			}
		})
	}
}

func TestTaskMutationResponseModes(t *testing.T) {
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("task-mutation-response"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	getStore := func() *storage.Store { return store }

	createResult, err := handleTaskCreate(getStore, mutationRequest(map[string]any{
		"title":       "Compact task",
		"description": "large task description sentinel",
	}))
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	createSummary := mutationResultMap(t, createResult)
	assertMutationKeys(t, createSummary, "success", "taskId", "status", "updatedAt")
	taskID, ok := createSummary["taskId"].(string)
	if !ok || taskID == "" {
		t.Fatalf("taskId = %#v", createSummary["taskId"])
	}
	storedTask, err := store.Tasks.Get(taskID)
	if err != nil {
		t.Fatalf("get created task: %v", err)
	}
	if storedTask.Description != "large task description sentinel" {
		t.Fatalf("stored description = %q", storedTask.Description)
	}

	updateResult, err := handleTaskUpdate(getStore, mutationRequest(map[string]any{
		"taskId":      taskID,
		"status":      "in-progress",
		"appendNotes": "implementation note sentinel",
	}))
	if err != nil {
		t.Fatalf("update task: %v", err)
	}
	updateSummary := mutationResultMap(t, updateResult)
	assertMutationKeys(t, updateSummary, "success", "taskId", "status", "updatedAt")
	if updateSummary["status"] != "in-progress" {
		t.Fatalf("summary status = %#v", updateSummary["status"])
	}
	storedTask, err = store.Tasks.Get(taskID)
	if err != nil {
		t.Fatalf("get updated task: %v", err)
	}
	if storedTask.ImplementationNotes != "implementation note sentinel" {
		t.Fatalf("stored notes = %q", storedTask.ImplementationNotes)
	}

	fullResult, err := handleTaskUpdate(getStore, mutationRequest(map[string]any{
		"taskId": taskID,
		"title":  "Legacy full task",
		"return": mutationReturnFull,
	}))
	if err != nil {
		t.Fatalf("full task update: %v", err)
	}
	fullPayload := mutationResultMap(t, fullResult)
	if fullPayload["id"] != taskID || fullPayload["title"] != "Legacy full task" {
		t.Fatalf("full task payload = %#v", fullPayload)
	}
	if _, ok := fullPayload["success"]; ok {
		t.Fatalf("full task payload unexpectedly wrapped: %#v", fullPayload)
	}

	beforeInvalid, err := store.Tasks.Get(taskID)
	if err != nil {
		t.Fatalf("get task before invalid update: %v", err)
	}
	invalidResult, err := handleTaskUpdate(getStore, mutationRequest(map[string]any{
		"taskId": taskID,
		"title":  "must not persist",
		"return": "compact",
	}))
	if err != nil {
		t.Fatalf("invalid task update: %v", err)
	}
	assertMutationModeError(t, invalidResult)
	afterInvalid, err := store.Tasks.Get(taskID)
	if err != nil {
		t.Fatalf("get task after invalid update: %v", err)
	}
	if afterInvalid.Title != beforeInvalid.Title {
		t.Fatalf("invalid update changed title from %q to %q", beforeInvalid.Title, afterInvalid.Title)
	}

	tasksBefore, err := store.Tasks.ListActive()
	if err != nil {
		t.Fatalf("list tasks before invalid create: %v", err)
	}
	invalidCreate, err := handleTaskCreate(getStore, mutationRequest(map[string]any{
		"title":  "must not be created",
		"return": "compact",
	}))
	if err != nil {
		t.Fatalf("invalid task create: %v", err)
	}
	assertMutationModeError(t, invalidCreate)
	tasksAfter, err := store.Tasks.ListActive()
	if err != nil {
		t.Fatalf("list tasks after invalid create: %v", err)
	}
	if len(tasksAfter) != len(tasksBefore) {
		t.Fatalf("invalid task create changed task count from %d to %d", len(tasksBefore), len(tasksAfter))
	}

	fullCreate, err := handleTaskCreate(getStore, mutationRequest(map[string]any{
		"title":       "Full create",
		"description": "full create description",
		"return":      mutationReturnFull,
	}))
	if err != nil {
		t.Fatalf("full task create: %v", err)
	}
	fullCreatePayload := mutationResultMap(t, fullCreate)
	if fullCreatePayload["title"] != "Full create" || fullCreatePayload["description"] != "full create description" {
		t.Fatalf("full task create payload = %#v", fullCreatePayload)
	}
	if _, ok := fullCreatePayload["success"]; ok {
		t.Fatalf("full task create unexpectedly wrapped: %#v", fullCreatePayload)
	}
}

func TestMCPTaskUpdateUsesBestEffortIndexing(t *testing.T) {
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("mcp-task-update-indexing"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	getStore := func() *storage.Store { return store }
	seedTask(t, store, "fast01", "Fast MCP update")

	oldBestEffortIndexTask := mcpBestEffortIndexTask
	t.Cleanup(func() {
		mcpBestEffortIndexTask = oldBestEffortIndexTask
	})

	bestEffortCalls := 0
	mcpBestEffortIndexTask = func(_ *storage.Store, id string) {
		bestEffortCalls++
		if id != "fast01" {
			t.Fatalf("best-effort index id = %q, want fast01", id)
		}
	}

	result, err := handleTaskUpdate(getStore, mutationRequest(map[string]any{
		"taskId":      "fast01",
		"status":      "in-progress",
		"appendNotes": "update should return before semantic indexing",
	}))
	if err != nil {
		t.Fatalf("update task: %v", err)
	}
	if result == nil || result.IsError {
		t.Fatalf("update task returned error result: %s", mutationResultText(t, result))
	}
	if bestEffortCalls != 1 {
		t.Fatalf("best-effort index calls = %d, want 1", bestEffortCalls)
	}
	storedTask, err := store.Tasks.Get("fast01")
	if err != nil {
		t.Fatalf("get updated task: %v", err)
	}
	if storedTask.Status != "in-progress" || storedTask.ImplementationNotes != "update should return before semantic indexing" {
		t.Fatalf("stored task = status %q notes %q", storedTask.Status, storedTask.ImplementationNotes)
	}
}

func TestMCPTimeMutationsUseBestEffortIndexing(t *testing.T) {
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("mcp-time-indexing"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	getStore := func() *storage.Store { return store }
	seedTask(t, store, "time01", "Fast MCP time")

	oldBestEffortIndexTask := mcpBestEffortIndexTask
	t.Cleanup(func() {
		mcpBestEffortIndexTask = oldBestEffortIndexTask
	})

	bestEffortCalls := 0
	mcpBestEffortIndexTask = func(_ *storage.Store, id string) {
		bestEffortCalls++
		if id != "time01" {
			t.Fatalf("best-effort index id = %q, want time01", id)
		}
	}

	addResult, err := handleTimeAdd(getStore, mutationRequest(map[string]any{
		"taskId":   "time01",
		"duration": "5m",
		"note":     "manual entry",
	}))
	if err != nil {
		t.Fatalf("add time: %v", err)
	}
	if addResult == nil || addResult.IsError {
		t.Fatalf("add time returned error result: %s", mutationResultText(t, addResult))
	}
	if bestEffortCalls != 1 {
		t.Fatalf("best-effort calls after add = %d, want 1", bestEffortCalls)
	}

	if err := store.Time.Start("time01", "Fast MCP time"); err != nil {
		t.Fatalf("start timer: %v", err)
	}
	stopResult, err := handleTimeStop(getStore, mutationRequest(map[string]any{"taskId": "time01"}))
	if err != nil {
		t.Fatalf("stop time: %v", err)
	}
	if stopResult == nil || stopResult.IsError {
		t.Fatalf("stop time returned error result: %s", mutationResultText(t, stopResult))
	}
	if bestEffortCalls != 2 {
		t.Fatalf("best-effort calls after stop = %d, want 2", bestEffortCalls)
	}
}

func TestMCPTimeMutationsRejectStaleExpectedHashWithoutSideEffects(t *testing.T) {
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("mcp-time-occ"); err != nil {
		t.Fatal(err)
	}
	seedTask(t, store, "time-occ", "secret MCP time title")
	base, err := store.Tasks.Get("time-occ")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tasklifecycle.New(store).UpdateTask(t.Context(), base.ID, tasklifecycle.TaskUpdateOptions{ExpectedHash: base.CanonicalHash, Mutate: func(task *models.Task) error { task.Description = "secret description"; return nil }}); err != nil {
		t.Fatal(err)
	}
	historyBefore, _ := store.Versions.GetHistory(base.ID)
	addResult, err := handleTimeAdd(func() *storage.Store { return store }, mutationRequest(map[string]any{"taskId": base.ID, "duration": "5m", "expectedHash": base.CanonicalHash}))
	if err != nil {
		t.Fatal(err)
	}
	addText := mutationResultText(t, addResult)
	if addResult == nil || !addResult.IsError || strings.Contains(addText, "secret") {
		t.Fatalf("stale add result = %q", addText)
	}
	entries, _ := store.Time.GetEntries(base.ID)
	historyAfter, _ := store.Versions.GetHistory(base.ID)
	if len(entries) != 0 || len(historyAfter.Versions) != len(historyBefore.Versions) {
		t.Fatalf("stale add side effects: entries=%#v history=%d/%d", entries, len(historyAfter.Versions), len(historyBefore.Versions))
	}
	if err := store.Time.SaveState(&models.TimeState{Active: []models.ActiveTimer{{TaskID: base.ID, StartedAt: time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano)}}}); err != nil {
		t.Fatal(err)
	}
	stopResult, err := handleTimeStop(func() *storage.Store { return store }, mutationRequest(map[string]any{"taskId": base.ID, "expectedHash": base.CanonicalHash}))
	if err != nil {
		t.Fatal(err)
	}
	stopText := mutationResultText(t, stopResult)
	if stopResult == nil || !stopResult.IsError || strings.Contains(stopText, "secret") {
		t.Fatalf("stale stop result = %q", stopText)
	}
	state, _ := store.Time.GetState()
	if len(state.Active) != 1 || len(entries) != 0 {
		t.Fatalf("stale stop side effects: state=%#v entries=%#v", state, entries)
	}
}

func seedTask(t *testing.T, store *storage.Store, id, title string) {
	t.Helper()
	now := time.Now().UTC()
	if err := store.Tasks.Create(&models.Task{
		ID:        id,
		Title:     title,
		Status:    "todo",
		Priority:  "medium",
		Labels:    []string{},
		CreatedAt: now,
		UpdatedAt: now,
	}); err != nil {
		t.Fatalf("seed task: %v", err)
	}
}

func TestDocMutationResponseModes(t *testing.T) {
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("doc-mutation-response"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	getStore := func() *storage.Store { return store }

	createResult, err := handleDocCreate(getStore, mutationRequest(map[string]any{
		"title":   "Compact Doc",
		"content": "## One\nlarge document content sentinel\n\n## Two\nunchanged",
	}))
	if err != nil {
		t.Fatalf("create doc: %v", err)
	}
	createSummary := mutationResultMap(t, createResult)
	assertMutationKeys(t, createSummary, "success", "path", "updatedAt")
	if createSummary["path"] != "compact-doc" {
		t.Fatalf("summary path = %#v", createSummary["path"])
	}
	storedDoc, err := store.Docs.Get("compact-doc")
	if err != nil {
		t.Fatalf("get created doc: %v", err)
	}
	if !strings.Contains(storedDoc.Content, "large document content sentinel") {
		t.Fatalf("stored content = %q", storedDoc.Content)
	}

	updateCases := []map[string]any{
		{"path": "compact-doc", "description": "metadata update"},
		{"path": "compact-doc", "appendContent": "\nappended content"},
		{"path": "compact-doc", "section": "One", "content": "## One\nreplacement"},
		{"path": "compact-doc", "clear": []any{"content"}},
	}
	for i, args := range updateCases {
		result, updateErr := handleDocUpdate(getStore, mutationRequest(args))
		if updateErr != nil {
			t.Fatalf("doc update %d: %v", i, updateErr)
		}
		assertMutationKeys(t, mutationResultMap(t, result), "success", "path", "updatedAt")
	}

	invalidResult, err := handleDocUpdate(getStore, mutationRequest(map[string]any{
		"path":        "compact-doc",
		"description": "must not persist",
		"return":      "compact",
	}))
	if err != nil {
		t.Fatalf("invalid doc update: %v", err)
	}
	assertMutationModeError(t, invalidResult)
	storedDoc, err = store.Docs.Get("compact-doc")
	if err != nil {
		t.Fatalf("get doc after invalid update: %v", err)
	}
	if storedDoc.Description != "metadata update" {
		t.Fatalf("invalid update changed description to %q", storedDoc.Description)
	}

	renameResult, err := handleDocUpdate(getStore, mutationRequest(map[string]any{
		"path":    "compact-doc",
		"newPath": "guides/renamed-doc",
	}))
	if err != nil {
		t.Fatalf("rename doc: %v", err)
	}
	renameSummary := mutationResultMap(t, renameResult)
	assertMutationKeys(t, renameSummary, "success", "path", "previousPath", "updatedAt")
	if renameSummary["path"] != "guides/renamed-doc" || renameSummary["previousPath"] != "compact-doc" {
		t.Fatalf("rename summary = %#v", renameSummary)
	}

	fullResult, err := handleDocUpdate(getStore, mutationRequest(map[string]any{
		"path":    "guides/renamed-doc",
		"content": "legacy full content",
		"return":  mutationReturnFull,
	}))
	if err != nil {
		t.Fatalf("full doc update: %v", err)
	}
	fullPayload := mutationResultMap(t, fullResult)
	if fullPayload["path"] != "guides/renamed-doc" || fullPayload["content"] != "legacy full content" {
		t.Fatalf("full doc payload = %#v", fullPayload)
	}
	if _, ok := fullPayload["success"]; ok {
		t.Fatalf("full doc payload unexpectedly wrapped: %#v", fullPayload)
	}

	docsBefore, err := store.Docs.List()
	if err != nil {
		t.Fatalf("list docs before invalid create: %v", err)
	}
	invalidCreate, err := handleDocCreate(getStore, mutationRequest(map[string]any{
		"title":  "Must Not Be Created",
		"return": "compact",
	}))
	if err != nil {
		t.Fatalf("invalid doc create: %v", err)
	}
	assertMutationModeError(t, invalidCreate)
	docsAfter, err := store.Docs.List()
	if err != nil {
		t.Fatalf("list docs after invalid create: %v", err)
	}
	if len(docsAfter) != len(docsBefore) {
		t.Fatalf("invalid doc create changed doc count from %d to %d", len(docsBefore), len(docsAfter))
	}

	fullCreate, err := handleDocCreate(getStore, mutationRequest(map[string]any{
		"title":   "Full Doc Create",
		"content": "full doc create content",
		"return":  mutationReturnFull,
	}))
	if err != nil {
		t.Fatalf("full doc create: %v", err)
	}
	fullCreatePayload := mutationResultMap(t, fullCreate)
	if fullCreatePayload["path"] != "full-doc-create" || fullCreatePayload["content"] != "full doc create content" {
		t.Fatalf("full doc create payload = %#v", fullCreatePayload)
	}
	if _, ok := fullCreatePayload["success"]; ok {
		t.Fatalf("full doc create unexpectedly wrapped: %#v", fullCreatePayload)
	}
}

func mutationRequest(args map[string]any) mcp.CallToolRequest {
	return mcp.CallToolRequest{Params: mcp.CallToolParams{Arguments: args}}
}

func mutationResultMap(t *testing.T, result *mcp.CallToolResult) map[string]any {
	t.Helper()
	text := mutationResultText(t, result)
	var payload map[string]any
	if err := json.Unmarshal([]byte(text), &payload); err != nil {
		t.Fatalf("decode mutation result: %v\n%s", err, text)
	}
	return payload
}

func mutationResultText(t *testing.T, result *mcp.CallToolResult) string {
	t.Helper()
	if result == nil || len(result.Content) != 1 {
		t.Fatalf("unexpected mutation result: %#v", result)
	}
	content, ok := result.Content[0].(mcp.TextContent)
	if !ok {
		t.Fatalf("unexpected mutation result content: %T", result.Content[0])
	}
	return content.Text
}

func assertMutationKeys(t *testing.T, payload map[string]any, expected ...string) {
	t.Helper()
	if len(payload) != len(expected) {
		t.Fatalf("result keys = %#v, want %v", payload, expected)
	}
	for _, key := range expected {
		if _, ok := payload[key]; !ok {
			t.Fatalf("result missing key %q: %#v", key, payload)
		}
	}
}

func assertMutationModeError(t *testing.T, result *mcp.CallToolResult) {
	t.Helper()
	if result == nil || !result.IsError {
		t.Fatalf("expected MCP error result, got %#v", result)
	}
	text := mutationResultText(t, result)
	if !strings.Contains(text, mutationReturnSummary) || !strings.Contains(text, mutationReturnFull) {
		t.Fatalf("mode error does not list valid values: %q", text)
	}
}

type mutationTestServer struct {
	*mcpserver.MCPServer
	help map[string]HelpEntry
}

func (server *mutationTestServer) RegisterHelp(key string, entry HelpEntry) {
	if server.help == nil {
		server.help = make(map[string]HelpEntry)
	}
	server.help[key] = entry
}

func callRegisteredMutationTool(t *testing.T, server *mcpserver.MCPServer, tool string, args map[string]any) (string, bool) {
	t.Helper()
	message, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "tools/call",
		"params":  map[string]any{"name": tool, "arguments": args},
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
	return envelope.Result.Content[0].Text, envelope.Result.IsError
}
