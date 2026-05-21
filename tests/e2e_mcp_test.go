package tests

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"
)

// setupMCPTest creates a test project + MCP client with project set.
func setupMCPTest(t *testing.T) (*MCPClient, string) {
	t.Helper()
	dir := setupTestProject(t)
	client := startMCPServer(t)
	client.Initialize()
	client.SetProject(dir)
	return client, dir
}

// TestMCP_TaskLifecycle tests the full task lifecycle via MCP:
// create → add AC → time start → in-progress + plan → check AC (x4)
// → time stop → final notes → done → verify → time report
func TestMCP_TaskLifecycle(t *testing.T) {
	client, _ := setupMCPTest(t)

	var taskID string

	// Step 1: Create task
	t.Run("create task", func(t *testing.T) {
		result := client.CallTool("tasks", map[string]any{
			"action":      "create",
			"title":       "E2E MCP: Implement Auth Feature",
			"description": "Implement JWT authentication for the API.",
			"priority":    "high",
			"labels":      []string{"e2e-test", "auth", "feature"},
			"assignee":    "@me",
		})
		id, ok := result["id"].(string)
		if !ok || id == "" {
			t.Fatalf("no task id in response: %v", result)
		}
		taskID = id
		t.Logf("created task: %s", taskID)
	})

	if taskID == "" {
		t.Fatal("cannot continue without task ID")
	}

	// Step 2: Add 4 acceptance criteria
	t.Run("add AC", func(t *testing.T) {
		result := client.CallTool("tasks", map[string]any{
			"action": "update",
			"taskId": taskID,
			"addAc": []string{
				"JWT tokens are generated on login",
				"Tokens expire after 1 hour",
				"Refresh token flow works",
				"Unit tests have >90% coverage",
			},
		})
		acs, ok := result["acceptanceCriteria"].([]any)
		if !ok || len(acs) != 4 {
			t.Fatalf("expected 4 AC, got: %v", result["acceptanceCriteria"])
		}
	})

	// Step 3: Start time tracking
	t.Run("start time", func(t *testing.T) {
		result := client.CallTool("time", map[string]any{
			"action": "start",
			"taskId": taskID,
		})
		if success, ok := result["success"].(bool); !ok || !success {
			t.Fatalf("time start failed: %v", result)
		}
	})

	// Step 4: Set in-progress + add plan
	t.Run("in-progress + plan", func(t *testing.T) {
		result := client.CallTool("tasks", map[string]any{
			"action": "update",
			"taskId": taskID,
			"status": "in-progress",
			"plan":   "1. Research JWT\n2. Design tokens\n3. Implement endpoints\n4. Write tests",
		})
		status, _ := result["status"].(string)
		if status != "in-progress" {
			t.Errorf("expected in-progress, got %q", status)
		}
	})

	// Step 5: Check ACs one by one
	for i := 1; i <= 4; i++ {
		i := i
		t.Run("check AC "+string(rune('0'+i)), func(t *testing.T) {
			client.CallTool("tasks", map[string]any{
				"action":      "update",
				"taskId":      taskID,
				"checkAc":     []int{i},
				"appendNotes": "Completed AC step",
			})
		})
	}

	// Step 6: Stop time tracking
	t.Run("stop time", func(t *testing.T) {
		result := client.CallTool("time", map[string]any{
			"action": "stop",
			"taskId": taskID,
		})
		if success, ok := result["success"].(bool); !ok || !success {
			t.Fatalf("time stop failed: %v", result)
		}
	})

	// Step 7: Add final notes
	t.Run("final notes", func(t *testing.T) {
		client.CallTool("tasks", map[string]any{
			"action": "update",
			"taskId": taskID,
			"notes":  "## Summary\nImplemented JWT auth.\n\n## Changes\n- Login endpoint\n- Refresh endpoint\n- Auth middleware",
		})
	})

	// Step 8: Mark done
	t.Run("mark done", func(t *testing.T) {
		client.CallTool("tasks", map[string]any{
			"action": "update",
			"taskId": taskID,
			"status": "done",
		})
	})

	// Step 9: Verify final state
	t.Run("verify state", func(t *testing.T) {
		raw := client.CallToolRaw("tasks", map[string]any{
			"action": "get",
			"taskId": taskID,
		})

		var task map[string]any
		if err := json.Unmarshal([]byte(raw), &task); err != nil {
			t.Fatalf("parse task: %v", err)
		}

		if task["status"] != "done" {
			t.Errorf("expected done, got %v", task["status"])
		}

		acs, _ := task["acceptanceCriteria"].([]any)
		if len(acs) != 4 {
			t.Fatalf("expected 4 AC, got %d", len(acs))
		}
		for i, ac := range acs {
			acMap, ok := ac.(map[string]any)
			if !ok {
				continue
			}
			if completed, _ := acMap["completed"].(bool); !completed {
				t.Errorf("AC #%d not checked", i+1)
			}
		}

		if task["implementationNotes"] == nil || task["implementationNotes"] == "" {
			t.Error("missing implementation notes")
		}
		if task["implementationPlan"] == nil || task["implementationPlan"] == "" {
			t.Error("missing implementation plan")
		}
	})

	// Step 10: Time report
	t.Run("time report", func(t *testing.T) {
		result := client.CallTool("time", map[string]any{
			"action": "report",
		})
		// Should have entries or total
		if result["entries"] == nil && result["total"] == nil {
			t.Logf("time report (may have 0 entries for fast tests): %v", result)
		}
	})
}

// TestMCP_DocumentWorkflow tests doc create → get → update → search.
func TestMCP_DocumentWorkflow(t *testing.T) {
	client, _ := setupMCPTest(t)

	var docPath string

	// Create doc
	t.Run("create doc", func(t *testing.T) {
		result := client.CallTool("docs", map[string]any{
			"action":      "create",
			"title":       "MCP E2E Test Doc",
			"description": "Test document created by MCP E2E tests",
			"tags":        []string{"test", "e2e", "mcp"},
			"folder":      "tests",
			"content":     "# MCP E2E Test Doc\n\n## Overview\nCreated by MCP E2E test suite.\n\n## Purpose\nTesting document workflow.",
		})
		path, ok := result["path"].(string)
		if !ok || path == "" {
			t.Fatalf("no path in response: %v", result)
		}
		docPath = path
		t.Logf("created doc: %s", docPath)
	})

	if docPath == "" {
		t.Fatal("cannot continue without doc path")
	}

	// Get doc (smart mode)
	t.Run("get doc smart", func(t *testing.T) {
		result := client.CallTool("docs", map[string]any{
			"action": "get",
			"path":   docPath,
			"smart":  true,
		})
		// Small doc should return content directly
		content, _ := result["content"].(string)
		if content == "" {
			t.Logf("doc response keys: %v", mapKeys(result))
		}
	})

	// Update doc (append)
	t.Run("update doc append", func(t *testing.T) {
		result := client.CallTool("docs", map[string]any{
			"action":        "update",
			"path":          docPath,
			"appendContent": "\n\n## References\n- Created by MCP E2E test",
		})
		path, _ := result["path"].(string)
		if path == "" {
			t.Logf("update response: %v", result)
		}
	})

	// Search for doc
	t.Run("search doc", func(t *testing.T) {
		raw := client.CallToolRaw("search", map[string]any{
			"action": "search",
			"query":  "MCP E2E Test",
			"type":   "doc",
		})
		if !strings.Contains(raw, "MCP E2E") && !strings.Contains(raw, docPath) {
			t.Logf("search may not find new doc immediately: %s", truncate(raw, 300))
		}
	})
}

func TestMCP_UpdateIgnoresEmptyStringsAndSupportsClear(t *testing.T) {
	client, _ := setupMCPTest(t)
	assertCleared := func(t *testing.T, result map[string]any, key string) {
		t.Helper()
		if value, ok := result[key]; ok && value != "" {
			t.Fatalf("expected %s to be cleared, got: %#v", key, value)
		}
	}

	t.Run("task", func(t *testing.T) {
		created := client.CallTool("tasks", map[string]any{
			"action":      "create",
			"title":       "Task title",
			"description": "Task description",
			"assignee":    "@me",
		})
		taskID, _ := created["id"].(string)
		if taskID == "" {
			t.Fatalf("missing task id: %v", created)
		}

		seeded := client.CallTool("tasks", map[string]any{
			"action": "update",
			"taskId": taskID,
			"plan":   "Initial plan",
			"notes":  "Initial notes",
		})
		if seeded["implementationPlan"] != "Initial plan" || seeded["implementationNotes"] != "Initial notes" {
			t.Fatalf("failed to seed task plan/notes: %+v", seeded)
		}

		unchanged := client.CallTool("tasks", map[string]any{
			"action":      "update",
			"taskId":      taskID,
			"title":       "",
			"description": "",
			"assignee":    "",
			"plan":        "",
			"notes":       "",
		})
		if unchanged["title"] != "Task title" {
			t.Fatalf("title changed on empty string update: %v", unchanged["title"])
		}
		if unchanged["description"] != "Task description" {
			t.Fatalf("description changed on empty string update: %v", unchanged["description"])
		}
		if unchanged["assignee"] != "@me" {
			t.Fatalf("assignee changed on empty string update: %v", unchanged["assignee"])
		}
		if unchanged["implementationPlan"] != "Initial plan" {
			t.Fatalf("plan changed on empty string update: %v", unchanged["implementationPlan"])
		}
		if unchanged["implementationNotes"] != "Initial notes" {
			t.Fatalf("notes changed on empty string update: %v", unchanged["implementationNotes"])
		}

		cleared := client.CallTool("tasks", map[string]any{
			"action": "update",
			"taskId": taskID,
			"clear":  []string{"title", "description", "assignee", "plan", "notes", "spec"},
		})
		assertCleared(t, cleared, "title")
		assertCleared(t, cleared, "description")
		assertCleared(t, cleared, "assignee")
		assertCleared(t, cleared, "implementationPlan")
		assertCleared(t, cleared, "implementationNotes")
	})

	t.Run("doc", func(t *testing.T) {
		created := client.CallTool("docs", map[string]any{
			"action":      "create",
			"title":       "Doc keep values",
			"description": "Doc description",
			"content":     "Original content",
		})
		docPath, _ := created["path"].(string)
		if docPath == "" {
			t.Fatalf("missing doc path: %v", created)
		}

		unchanged := client.CallTool("docs", map[string]any{
			"action":      "update",
			"path":        docPath,
			"title":       "",
			"description": "",
			"content":     "",
		})
		if unchanged["title"] != "Doc keep values" {
			t.Fatalf("title changed on empty string update: %v", unchanged["title"])
		}
		if unchanged["description"] != "Doc description" {
			t.Fatalf("description changed on empty string update: %v", unchanged["description"])
		}
		if unchanged["content"] != "Original content" {
			t.Fatalf("content changed on empty string update: %v", unchanged["content"])
		}

		cleared := client.CallTool("docs", map[string]any{
			"action": "update",
			"path":   docPath,
			"clear":  []string{"title", "description", "content"},
		})
		assertCleared(t, cleared, "title")
		assertCleared(t, cleared, "description")
		assertCleared(t, cleared, "content")
	})

	t.Run("memory", func(t *testing.T) {
		created := client.CallTool("memory", map[string]any{
			"action":   "add",
			"title":    "Memory title",
			"content":  "Memory content",
			"category": "pattern",
		})
		memoryID, _ := created["id"].(string)
		if memoryID == "" {
			t.Fatalf("missing memory id: %v", created)
		}

		unchanged := client.CallTool("memory", map[string]any{
			"action":   "update",
			"id":       memoryID,
			"title":    "",
			"content":  "",
			"category": "",
		})
		if unchanged["title"] != "Memory title" {
			t.Fatalf("title changed on empty string update: %v", unchanged["title"])
		}
		if unchanged["content"] != "Memory content" {
			t.Fatalf("content changed on empty string update: %v", unchanged["content"])
		}
		if unchanged["category"] != "pattern" {
			t.Fatalf("category changed on empty string update: %v", unchanged["category"])
		}

		cleared := client.CallTool("memory", map[string]any{
			"action": "update",
			"id":     memoryID,
			"clear":  []string{"title", "content", "category"},
		})
		assertCleared(t, cleared, "title")
		assertCleared(t, cleared, "content")
		assertCleared(t, cleared, "category")
	})
}

// TestMCP_SearchWorkflow tests keyword search and list_tasks by label.
func TestMCP_SearchWorkflow(t *testing.T) {
	client, _ := setupMCPTest(t)

	// Create test data
	createResult := client.CallTool("tasks", map[string]any{
		"action":      "create",
		"title":       "Searchable Task ABC123",
		"description": "This task exists for search testing",
		"labels":      []string{"search-test"},
	})
	taskID, _ := createResult["id"].(string)

	client.CallTool("docs", map[string]any{
		"action":  "create",
		"title":   "Searchable Doc DEF456",
		"content": "Content for search testing",
		"tags":    []string{"search-test"},
	})

	// Keyword search for task
	t.Run("search task by keyword", func(t *testing.T) {
		raw := client.CallToolRaw("search", map[string]any{
			"action": "search",
			"query":  "ABC123",
			"mode":   "keyword",
			"type":   "task",
		})
		if taskID != "" && !strings.Contains(raw, taskID) {
			t.Logf("task %s not found in search: %s", taskID, truncate(raw, 300))
		}
	})

	// Keyword search for doc
	t.Run("search doc by keyword", func(t *testing.T) {
		raw := client.CallToolRaw("search", map[string]any{
			"action": "search",
			"query":  "DEF456",
			"mode":   "keyword",
			"type":   "doc",
		})
		if !strings.Contains(raw, "DEF456") {
			t.Logf("doc not found in search: %s", truncate(raw, 300))
		}
	})

	// List tasks by label
	t.Run("list tasks by label", func(t *testing.T) {
		if taskID == "" {
			t.Skip("no task ID from create")
		}
		result := client.CallTool("tasks", map[string]any{
			"action": "list",
			"label":  "search-test",
		})
		arr, ok := result["_array"].([]any)
		if ok {
			found := false
			for _, item := range arr {
				if m, ok := item.(map[string]any); ok {
					if m["id"] == taskID {
						found = true
						break
					}
				}
			}
			if !found {
				t.Errorf("task %s not found in label filter results", taskID)
			}
		} else {
			t.Logf("list_tasks response: %v", result)
		}
	})
}

// TestMCP_Board tests get_board returns valid structure.
func TestMCP_Board(t *testing.T) {
	client, _ := setupMCPTest(t)

	client.CallTool("tasks", map[string]any{
		"action": "create",
		"title":  "Board Test Task",
	})

	t.Run("get board", func(t *testing.T) {
		result := client.CallTool("tasks", map[string]any{
			"action": "board",
		})

		columns, ok := result["columns"].([]any)
		if !ok {
			t.Fatalf("expected columns array, got: %v", result)
		}
		if len(columns) == 0 {
			t.Error("expected at least one column")
		}

		total, ok := result["total"].(float64)
		if !ok {
			t.Errorf("expected total count, got: %v", result["total"])
		}
		if total < 1 {
			t.Errorf("expected at least 1 task, got %v", total)
		}
	})
}

// TestMCP_Validation tests validate with various scopes.
func TestMCP_Validation(t *testing.T) {
	client, _ := setupMCPTest(t)

	client.CallTool("tasks", map[string]any{
		"action": "create",
		"title":  "Validate Test Task",
	})
	client.CallTool("docs", map[string]any{
		"action": "create",
		"title":  "Validate Test Doc",
		"tags":   []string{"test"},
	})

	t.Run("validate all", func(t *testing.T) {
		result := client.CallTool("validate", map[string]any{
			"scope": "all",
		})
		if _, ok := result["valid"].(bool); !ok {
			t.Errorf("expected valid boolean, got: %v", result)
		}
		if result["scope"] != "all" {
			t.Errorf("expected scope=all, got: %v", result["scope"])
		}
	})

	t.Run("validate tasks", func(t *testing.T) {
		result := client.CallTool("validate", map[string]any{
			"scope": "tasks",
		})
		if result["scope"] != "tasks" {
			t.Errorf("expected scope=tasks, got: %v", result["scope"])
		}
	})

	t.Run("validate docs", func(t *testing.T) {
		result := client.CallTool("validate", map[string]any{
			"scope": "docs",
		})
		if result["scope"] != "docs" {
			t.Errorf("expected scope=docs, got: %v", result["scope"])
		}
	})

	t.Run("validate templates", func(t *testing.T) {
		result := client.CallTool("validate", map[string]any{
			"scope": "templates",
		})
		if result["scope"] != "templates" {
			t.Errorf("expected scope=templates, got: %v", result["scope"])
		}
	})

	t.Run("validate sdd", func(t *testing.T) {
		result := client.CallTool("validate", map[string]any{
			"scope": "sdd",
		})
		if result["scope"] != "sdd" {
			t.Errorf("expected scope=sdd, got: %v", result["scope"])
		}
	})

	t.Run("validate strict", func(t *testing.T) {
		result := client.CallTool("validate", map[string]any{
			"scope":  "all",
			"strict": true,
		})
		strict, ok := result["strict"].(bool)
		if !ok || !strict {
			t.Errorf("expected strict=true, got: %v", result["strict"])
		}
	})
}

// TestMCP_ReopenWorkflow tests reopening a done task via MCP.
func TestMCP_ReopenWorkflow(t *testing.T) {
	client, _ := setupMCPTest(t)

	// Create task
	createResult := client.CallTool("tasks", map[string]any{
		"action":   "create",
		"title":    "MCP Reopen Test",
		"assignee": "@me",
	})
	taskID, _ := createResult["id"].(string)
	if taskID == "" {
		t.Fatal("no task ID")
	}

	// Add 4 AC + set in-progress
	client.CallTool("tasks", map[string]any{
		"action": "update",
		"taskId": taskID,
		"addAc":  []string{"AC 1", "AC 2", "AC 3", "AC 4"},
		"status": "in-progress",
	})

	// Start timer, check all 4, stop timer, mark done
	client.CallTool("time", map[string]any{"action": "start", "taskId": taskID})
	client.CallTool("tasks", map[string]any{
		"action":  "update",
		"taskId":  taskID,
		"checkAc": []int{1, 2, 3, 4},
	})
	client.CallTool("time", map[string]any{"action": "stop", "taskId": taskID})
	client.CallTool("tasks", map[string]any{
		"action": "update",
		"taskId": taskID,
		"status": "done",
	})

	// Reopen
	t.Run("reopen", func(t *testing.T) {
		result := client.CallTool("tasks", map[string]any{
			"action": "update",
			"taskId": taskID,
			"status": "in-progress",
		})
		if result["status"] != "in-progress" {
			t.Errorf("expected in-progress, got %v", result["status"])
		}
	})

	// Add AC #5
	t.Run("add AC 5", func(t *testing.T) {
		client.CallTool("tasks", map[string]any{
			"action":      "update",
			"taskId":      taskID,
			"addAc":       []string{"Post-completion fix: Handle edge case"},
			"appendNotes": "Reopened: Adding edge case handling",
		})
	})

	// Start timer, check AC #5, stop timer, mark done
	t.Run("fix and complete", func(t *testing.T) {
		client.CallTool("time", map[string]any{"action": "start", "taskId": taskID})
		client.CallTool("tasks", map[string]any{
			"action":      "update",
			"taskId":      taskID,
			"checkAc":     []int{5},
			"appendNotes": "Implemented edge case handling",
		})
		client.CallTool("time", map[string]any{"action": "stop", "taskId": taskID})
		client.CallTool("tasks", map[string]any{
			"action": "update",
			"taskId": taskID,
			"status": "done",
		})
	})

	// Verify 5/5 AC
	t.Run("verify 5/5 AC", func(t *testing.T) {
		raw := client.CallToolRaw("tasks", map[string]any{
			"action": "get",
			"taskId": taskID,
		})

		var task map[string]any
		if err := json.Unmarshal([]byte(raw), &task); err != nil {
			t.Fatalf("parse task: %v", err)
		}

		acs, _ := task["acceptanceCriteria"].([]any)
		if len(acs) != 5 {
			t.Fatalf("expected 5 AC, got %d", len(acs))
		}
		for i, ac := range acs {
			acMap, ok := ac.(map[string]any)
			if !ok {
				continue
			}
			if completed, _ := acMap["completed"].(bool); !completed {
				t.Errorf("AC #%d not checked", i+1)
			}
		}
	})
}

// TestMCP_SemanticSearch tests reindex + search modes via MCP.
// Requires ONNX Runtime + model. Skip unless TEST_SEMANTIC=1.
func TestMCP_SemanticSearch(t *testing.T) {
	if os.Getenv("TEST_SEMANTIC") != "1" {
		t.Skip("skipping semantic search test (set TEST_SEMANTIC=1 to enable)")
	}

	client, dir := setupMCPTest(t)

	// Create test data
	client.CallTool("tasks", map[string]any{
		"action":      "create",
		"title":       "Semantic Auth Task",
		"description": "Implement JWT authentication with RS256",
		"labels":      []string{"auth", "semantic-test"},
	})

	client.CallTool("docs", map[string]any{
		"action":  "create",
		"title":   "Semantic Security Doc",
		"content": "# Security Patterns\n\n## JWT Authentication\n- RS256 algorithm\n- Short-lived tokens\n- Refresh flow",
		"tags":    []string{"security", "semantic-test"},
	})

	// Set model via CLI (MCP doesn't have model tools)
	bin := getBinaryPath(t)
	setModelCmd := exec.CommandContext(
		context.Background(), bin, "model", "set", "all-MiniLM-L6-v2",
	)
	setModelCmd.Dir = dir
	setModelCmd.Env = append(os.Environ(), "NO_COLOR=1", "KNOWNS_RUNTIME_INLINE=1")
	if out, err := setModelCmd.CombinedOutput(); err != nil {
		t.Fatalf("model set failed: %v\n%s", err, string(out))
	}

	// Step 1: Reindex via MCP — reindex_search was removed in the consolidated MCP tool refactor
	t.Run("reindex", func(t *testing.T) {
		t.Skip("reindex_search tool was removed in consolidated MCP refactor")
	})

	// Step 2: Keyword search via MCP
	t.Run("keyword search", func(t *testing.T) {
		raw := client.CallToolRaw("search", map[string]any{
			"action": "search",
			"query":  "JWT authentication",
			"mode":   "keyword",
		})
		if raw == "" {
			t.Error("empty search result")
		}
		t.Logf("keyword search result: %s", truncate(raw, 300))
	})

	// Step 3: Hybrid search via MCP
	t.Run("hybrid search", func(t *testing.T) {
		raw := client.CallToolRaw("search", map[string]any{
			"action": "search",
			"query":  "authentication security patterns",
			"mode":   "hybrid",
		})
		if raw == "" {
			t.Error("empty search result")
		}
		t.Logf("hybrid search result: %s", truncate(raw, 300))
	})

	// Step 4: Search filtered by type
	t.Run("search docs only", func(t *testing.T) {
		raw := client.CallToolRaw("search", map[string]any{
			"action": "search",
			"query":  "security",
			"type":   "doc",
		})
		t.Logf("doc search result: %s", truncate(raw, 300))
	})

	t.Run("search tasks only", func(t *testing.T) {
		raw := client.CallToolRaw("search", map[string]any{
			"action": "search",
			"query":  "authentication",
			"type":   "task",
		})
		t.Logf("task search result: %s", truncate(raw, 300))
	})

	t.Run("search rejects code type", func(t *testing.T) {
		raw := client.CallToolRaw("search", map[string]any{
			"action": "search",
			"query":  "authentication security patterns",
			"type":   "code",
			"mode":   "hybrid",
			"limit":  10,
		})
		if !strings.Contains(raw, "error") {
			t.Fatalf("expected MCP error for code search type, got: %s", raw)
		}
	})

	t.Run("code graph action is unsupported", func(t *testing.T) {
		raw := client.CallToolRaw("code", map[string]any{
			"action": "graph",
		})
		if !strings.Contains(raw, "unsupported action: graph") {
			t.Fatalf("expected unsupported graph action, got: %s", raw)
		}
	})
}

// TestMCP_InitialTool verifies the initial tool returns operating instructions.
func TestMCP_InitialTool(t *testing.T) {
	client := startMCPServer(t)
	client.Initialize()

	t.Run("returns non-empty instructions", func(t *testing.T) {
		raw := client.CallToolRaw("initial", map[string]any{})
		if raw == "" {
			t.Fatal("initial tool returned empty result")
		}
		if !strings.Contains(raw, "Session Ready") {
			t.Fatalf("initial tool result missing expected content, got: %s", raw[:min(len(raw), 200)])
		}
		if !strings.Contains(raw, "Code Intelligence Rules") {
			t.Fatal("initial tool result missing Code Intelligence Rules section")
		}
		if !strings.Contains(raw, "Workflow") {
			t.Fatal("initial tool result missing Workflow section")
		}
	})
}

// TestMCP_InitializeInstructions verifies the initialize response contains instructions.
func TestMCP_InitializeInstructions(t *testing.T) {
	client := startMCPServer(t)
	resp := client.InitializeRaw()

	result, ok := resp["result"].(map[string]any)
	if !ok {
		t.Fatalf("no result in initialize response: %v", resp)
	}

	instructions, ok := result["instructions"].(string)
	if !ok || instructions == "" {
		t.Fatalf("no instructions in initialize result: %v", result)
	}

	if !strings.Contains(instructions, "initial") {
		t.Fatalf("instructions should mention the initial tool, got: %s", instructions)
	}
}

// mapKeys returns the keys of a map (for debugging).
func mapKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	return keys
}
