package tests

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"
)

// TestCLI_TaskLifecycle tests the complete task lifecycle:
// create → add AC → time start → in-progress + plan → check AC (x4) + append-notes
// → time stop → final notes → done → verify state → time report
func TestCLI_TaskLifecycle(t *testing.T) {
	dir := setupTestProject(t)
	var taskID string

	// Step 1: Create task
	t.Run("create task", func(t *testing.T) {
		res := runCli(t, dir,
			"task", "create", "E2E: Implement Auth Feature",
			"-d", "Implement JWT authentication for the API.",
			"--priority", "high",
			"-l", "e2e-test", "-l", "auth", "-l", "feature",
			"-a", "@me",
		)
		requireSuccess(t, res, "create task")
		taskID = extractTaskIDShort(res.Stdout + res.Stderr)
		if taskID == "" {
			t.Fatalf("no task ID found in output:\n%s\n%s", res.Stdout, res.Stderr)
		}
		t.Logf("created: %s", taskID)
	})

	if taskID == "" {
		t.Fatal("cannot continue without task ID")
	}

	shortID := taskID

	// Step 2: Add 4 acceptance criteria
	t.Run("add acceptance criteria", func(t *testing.T) {
		acs := []string{
			"JWT tokens are generated on login",
			"Tokens expire after 1 hour",
			"Refresh token flow works",
			"Unit tests have >90% coverage",
		}
		for _, ac := range acs {
			res := runCli(t, dir, "task", "edit", shortID, "--ac", ac)
			requireSuccess(t, res, "add AC: "+ac)
		}
	})

	// Step 3: Start time tracking
	t.Run("start time tracking", func(t *testing.T) {
		res := runCli(t, dir, "time", "start", shortID)
		requireSuccess(t, res)
	})

	// Step 4: Set in-progress + add plan
	t.Run("set in-progress and plan", func(t *testing.T) {
		res := runCli(t, dir, "task", "edit", shortID, "-s", "in-progress")
		requireSuccess(t, res)
		res = runCli(t, dir, "task", "edit", shortID, "--plan",
			"1. Research JWT best practices\n2. Design token structure\n3. Implement /login endpoint\n4. Implement /refresh endpoint\n5. Add auth middleware\n6. Write unit tests\n7. Update API documentation")
		requireSuccess(t, res)
	})

	// Step 5: Check ACs one by one + append notes
	t.Run("check AC 1 + notes", func(t *testing.T) {
		res := runCli(t, dir, "task", "edit", shortID, "--check-ac", "1")
		requireSuccess(t, res)
		res = runCli(t, dir, "task", "edit", shortID, "--append-notes", "Implemented JWT generation using jsonwebtoken library")
		requireSuccess(t, res)
	})
	t.Run("check AC 2 + notes", func(t *testing.T) {
		res := runCli(t, dir, "task", "edit", shortID, "--check-ac", "2")
		requireSuccess(t, res)
		res = runCli(t, dir, "task", "edit", shortID, "--append-notes", "Token expiry set to 1 hour, configurable via env")
		requireSuccess(t, res)
	})
	t.Run("check AC 3 + notes", func(t *testing.T) {
		res := runCli(t, dir, "task", "edit", shortID, "--check-ac", "3")
		requireSuccess(t, res)
		res = runCli(t, dir, "task", "edit", shortID, "--append-notes", "Refresh token flow implemented with 7-day expiry")
		requireSuccess(t, res)
	})
	t.Run("check AC 4 + notes", func(t *testing.T) {
		res := runCli(t, dir, "task", "edit", shortID, "--check-ac", "4")
		requireSuccess(t, res)
		res = runCli(t, dir, "task", "edit", shortID, "--append-notes", "24 unit tests, 94% coverage achieved")
		requireSuccess(t, res)
	})

	// Step 6: Stop time tracking
	t.Run("stop time tracking", func(t *testing.T) {
		res := runCli(t, dir, "time", "stop")
		requireSuccess(t, res)
	})

	// Step 7: Add final implementation notes
	t.Run("add final notes", func(t *testing.T) {
		notes := "## Summary\nImplemented complete JWT authentication system.\n\n## Changes\n- POST /api/auth/login\n- POST /api/auth/refresh\n- Added auth middleware\n\n## Tests\n- 24 unit tests\n- Coverage: 94%"
		res := runCli(t, dir, "task", "edit", shortID, "--notes", notes)
		requireSuccess(t, res)
	})

	// Step 8: Mark as done
	t.Run("mark done", func(t *testing.T) {
		res := runCli(t, dir, "task", "edit", shortID, "-s", "done")
		requireSuccess(t, res)
	})

	// Step 9: Verify final state
	t.Run("verify final state", func(t *testing.T) {
		res := runCli(t, dir, "task", shortID, "--plain")
		requireSuccess(t, res)

		output := strings.ToLower(res.Stdout)
		if !strings.Contains(output, "done") {
			t.Errorf("task not marked as done:\n%s", res.Stdout)
		}

		checkedCount := len(regexp.MustCompile(`(?i)\[x\]`).FindAllString(res.Stdout, -1))
		if checkedCount != 4 {
			t.Errorf("expected 4 checked AC, found %d\n%s", checkedCount, res.Stdout)
		}
	})

	// Step 10: Verify time tracking
	t.Run("time report", func(t *testing.T) {
		res := runCli(t, dir, "time", "report")
		requireSuccess(t, res)
	})
}

// TestCLI_DocumentWorkflow tests: create → edit content → get → append → search
func TestCLI_DocumentWorkflow(t *testing.T) {
	dir := setupTestProject(t)

	// Create doc
	t.Run("create doc", func(t *testing.T) {
		res := runCli(t, dir,
			"doc", "create", "Security Patterns",
			"-d", "Security patterns documentation",
			"-t", "test", "-t", "e2e", "-t", "security",
			"-f", "patterns",
		)
		requireSuccess(t, res)
	})

	// Set content
	t.Run("set doc content", func(t *testing.T) {
		content := "# Security Patterns\n\n## Overview\nThis document describes security patterns.\n\n## JWT Authentication\n- Use RS256 algorithm\n- Short-lived access tokens (1 hour)\n- Long-lived refresh tokens (7 days)"
		res := runCli(t, dir, "doc", "edit", "patterns/security-patterns", "-c", content)
		requireSuccess(t, res)
	})

	// Get doc with --plain
	t.Run("get doc", func(t *testing.T) {
		res := runCli(t, dir, "doc", "patterns/security-patterns", "--plain")
		requireSuccess(t, res)
		assertContains(t, res.Stdout, "JWT Authentication", "doc content")
	})

	// Append content
	t.Run("append doc content", func(t *testing.T) {
		res := runCli(t, dir, "doc", "edit", "patterns/security-patterns",
			"-a", "\n\n## References\n- Created by E2E test")
		requireSuccess(t, res)
	})

	// Search for doc
	t.Run("search for doc", func(t *testing.T) {
		res := runCli(t, dir, "search", "Security Patterns", "--type", "doc", "--plain")
		requireSuccess(t, res)
	})
}

// TestCLI_CrossReferences tests task→doc and doc→task cross-references.
func TestCLI_CrossReferences(t *testing.T) {
	dir := setupTestProject(t)

	// Create doc first
	res := runCli(t, dir, "doc", "create", "Test Pattern",
		"-d", "Test doc", "-t", "test", "-f", "patterns")
	requireSuccess(t, res)

	// Create task with doc ref
	var refTaskID string
	t.Run("create task with doc ref", func(t *testing.T) {
		res := runCli(t, dir, "task", "create", "Task with references",
			"-d", "See @doc/patterns/test-pattern for guidelines")
		requireSuccess(t, res)
		refTaskID = extractTaskIDShort(res.Stdout + res.Stderr)
		if refTaskID == "" {
			t.Fatal("no task ID found")
		}
	})

	// Add doc content with task ref
	t.Run("doc with task ref", func(t *testing.T) {
		content := "# Test Pattern\n\n## Related Tasks\n- @task-" + refTaskID + "\n\n## See Also\n- @doc/patterns/test-pattern"
		res := runCli(t, dir, "doc", "edit", "patterns/test-pattern", "-c", content)
		requireSuccess(t, res)
	})

	// Verify task has doc ref
	t.Run("verify task refs", func(t *testing.T) {
		res := runCli(t, dir, "task", refTaskID, "--plain")
		requireSuccess(t, res)
		assertContains(t, res.Stdout, "patterns/test-pattern", "doc ref in task")
	})

	// Verify doc has task ref
	t.Run("verify doc refs", func(t *testing.T) {
		res := runCli(t, dir, "doc", "patterns/test-pattern", "--plain")
		requireSuccess(t, res)
		assertContains(t, res.Stdout, refTaskID, "task ref in doc")
	})
}

// TestCLI_Search tests keyword search.
func TestCLI_Search(t *testing.T) {
	dir := setupTestProject(t)

	// Create some searchable data
	res := runCli(t, dir, "task", "create", "Unique Search Target XYZ789",
		"-d", "This task exists for search testing", "-l", "search-test")
	requireSuccess(t, res)

	t.Run("keyword search", func(t *testing.T) {
		res := runCli(t, dir, "search", "XYZ789", "--keyword", "--plain")
		// Even if exit code != 0 (e.g., no results warning), check output
		if res.ExitCode > 1 {
			t.Fatalf("search failed with code %d: %s", res.ExitCode, res.Stderr)
		}
	})
}

// TestCLI_Validation tests validate command with various scopes.
func TestCLI_Validation(t *testing.T) {
	dir := setupTestProject(t)

	// Create some data so there's something to validate
	runCli(t, dir, "task", "create", "Validation Test Task", "--ac", "Test criterion")
	runCli(t, dir, "doc", "create", "Validation Test Doc", "-d", "Test doc", "-t", "test")

	t.Run("validate all", func(t *testing.T) {
		res := runCli(t, dir, "validate", "--plain")
		// Exit code 0 = clean, 1 = warnings (acceptable)
		if res.ExitCode > 1 {
			t.Errorf("validate failed with code %d: %s", res.ExitCode, res.Stderr)
		}
	})

	t.Run("validate tasks", func(t *testing.T) {
		res := runCli(t, dir, "validate", "--scope", "tasks", "--plain")
		if res.ExitCode > 1 {
			t.Errorf("validate tasks failed: %s", res.Stderr)
		}
	})

	t.Run("validate docs", func(t *testing.T) {
		res := runCli(t, dir, "validate", "--scope", "docs", "--plain")
		if res.ExitCode > 1 {
			t.Errorf("validate docs failed: %s", res.Stderr)
		}
	})

	t.Run("validate templates", func(t *testing.T) {
		res := runCli(t, dir, "validate", "--scope", "templates", "--plain")
		if res.ExitCode > 1 {
			t.Errorf("validate templates failed: %s", res.Stderr)
		}
	})

	t.Run("validate sdd", func(t *testing.T) {
		res := runCli(t, dir, "validate", "--scope", "sdd", "--plain")
		if res.ExitCode > 1 {
			t.Errorf("validate sdd failed: %s", res.Stderr)
		}
	})

	t.Run("validate strict", func(t *testing.T) {
		res := runCli(t, dir, "validate", "--strict", "--plain")
		// Strict mode may fail (warnings become errors). Just verify it runs.
		t.Logf("strict mode exit code: %d", res.ExitCode)
	})
}

// TestCLI_ReopenWorkflow tests reopening a done task and adding more AC.
func TestCLI_ReopenWorkflow(t *testing.T) {
	dir := setupTestProject(t)

	// Create and complete a task with 4 AC
	res := runCli(t, dir, "task", "create", "Reopen Test Task",
		"-d", "Task for reopen testing",
		"--ac", "AC 1", "--ac", "AC 2", "--ac", "AC 3", "--ac", "AC 4",
		"-a", "@me",
	)
	requireSuccess(t, res)
	shortID := extractTaskIDShort(res.Stdout + res.Stderr)
	if shortID == "" {
		t.Fatal("no task ID found")
	}

	// Complete all 4 AC and mark done
	runCli(t, dir, "task", "edit", shortID, "-s", "in-progress")
	runCli(t, dir, "time", "start", shortID)
	for i := 1; i <= 4; i++ {
		runCli(t, dir, "task", "edit", shortID, "--check-ac", fmt.Sprintf("%d", i))
	}
	runCli(t, dir, "time", "stop")
	runCli(t, dir, "task", "edit", shortID, "-s", "done")

	// Reopen
	t.Run("reopen completed task", func(t *testing.T) {
		res := runCli(t, dir, "task", "edit", shortID, "-s", "in-progress")
		requireSuccess(t, res)
	})

	t.Run("add AC 5", func(t *testing.T) {
		res := runCli(t, dir, "task", "edit", shortID, "--ac", "Post-completion fix: Handle edge case")
		requireSuccess(t, res)
	})

	t.Run("restart timer", func(t *testing.T) {
		res := runCli(t, dir, "time", "start", shortID)
		requireSuccess(t, res)
	})

	t.Run("check AC 5", func(t *testing.T) {
		res := runCli(t, dir, "task", "edit", shortID, "--check-ac", "5")
		requireSuccess(t, res)
	})

	t.Run("stop timer", func(t *testing.T) {
		res := runCli(t, dir, "time", "stop")
		requireSuccess(t, res)
	})

	t.Run("mark done again", func(t *testing.T) {
		res := runCli(t, dir, "task", "edit", shortID, "-s", "done")
		requireSuccess(t, res)
	})

	t.Run("verify 5/5 AC", func(t *testing.T) {
		res := runCli(t, dir, "task", shortID, "--plain")
		requireSuccess(t, res)

		checkedCount := len(regexp.MustCompile(`(?i)\[x\]`).FindAllString(res.Stdout, -1))
		if checkedCount != 5 {
			t.Errorf("expected 5 checked AC, got %d\n%s", checkedCount, res.Stdout)
		}
	})
}

// TestCLI_SemanticSearch tests the semantic search workflow:
// model list → model download → model set → status check → reindex → semantic search → keyword search
// Requires ONNX Runtime + network access. Skip unless TEST_SEMANTIC=1.
func TestCLI_Sync(t *testing.T) {
	t.Run("sync instructions", func(t *testing.T) {
		dir := setupTestProject(t)
		res := runCli(t, dir, "sync", "--instructions", "--platform", "claude")
		requireSuccess(t, res)
		output := res.Stdout + res.Stderr
		assertContains(t, output, "Checking agent instruction files", "sync instructions output")
		assertContains(t, output, "CLAUDE.md", "sync instructions output")
		assertContains(t, output, "Sync complete.", "sync instructions output")
		if _, err := os.Stat(dir + "/CLAUDE.md"); err != nil {
			t.Fatalf("expected CLAUDE.md to exist after sync: %v", err)
		}
	})

	t.Run("sync skills", func(t *testing.T) {
		dir := setupTestProject(t)
		res := runCli(t, dir, "sync", "--skills")
		requireSuccess(t, res)
		output := res.Stdout + res.Stderr
		assertContains(t, output, "Syncing", "sync skills output")
		assertContains(t, output, "skill(s)", "sync skills output")
		assertContains(t, output, "Synced", "sync skills output")
		assertContains(t, output, "Sync complete.", "sync skills output")
	})
}

// TestCLI_SemanticSearch tests the semantic search workflow:
// model list → model download → model set → status check → reindex → semantic search → keyword search
// Requires ONNX Runtime + network access. Skip unless TEST_SEMANTIC=1.
func TestCLI_SemanticSearch(t *testing.T) {
	if os.Getenv("TEST_SEMANTIC") != "1" {
		t.Skip("skipping semantic search test (set TEST_SEMANTIC=1 to enable)")
	}

	dir := setupTestProject(t)

	// Create test data first (tasks + docs for search)
	res := runCli(t, dir, "task", "create", "Auth Feature: JWT Implementation",
		"-d", "Implement JWT authentication for the API.",
		"--priority", "high", "-l", "auth", "-l", "feature",
	)
	requireSuccess(t, res, "create task")

	res = runCli(t, dir, "doc", "create", "Security Patterns",
		"-d", "Security patterns documentation", "-t", "security", "-f", "patterns")
	requireSuccess(t, res, "create doc")

	res = runCli(t, dir, "doc", "edit", "patterns/security-patterns",
		"-c", "# Security Patterns\n\n## JWT Authentication\n- Use RS256 algorithm\n- Short-lived access tokens\n- Refresh token flow")
	requireSuccess(t, res, "set doc content")

	// Step 1: Model list
	t.Run("model list", func(t *testing.T) {
		res := runCli(t, dir, "model", "list")
		requireSuccess(t, res)
		assertContains(t, res.Stdout, "all-MiniLM-L6-v2", "model list should contain MiniLM")
	})

	// Step 2: Model download (180s timeout for network download)
	modelDownloaded := false
	t.Run("model download", func(t *testing.T) {
		res := runCliWithTimeout(t, dir, 180*time.Second, "model", "download", "all-MiniLM-L6-v2")
		output := res.Stdout + res.Stderr
		if res.ExitCode != 0 && strings.Contains(output, "HTTP 429") {
			t.Skipf("skipping semantic search test: model download was rate limited: %s", truncate(output, 300))
		}
		requireSuccess(t, res)
		modelDownloaded = true
		if !strings.Contains(output, "downloaded") && !strings.Contains(output, "already installed") {
			t.Logf("download output: %s", truncate(output, 500))
		}
	})
	if !modelDownloaded {
		t.Skip("skipping semantic search test: embedding model is unavailable")
	}

	// Step 3: Model set
	t.Run("model set", func(t *testing.T) {
		res := runCli(t, dir, "model", "set", "all-MiniLM-L6-v2")
		requireSuccess(t, res)
	})

	// Step 4: Status check
	t.Run("status check", func(t *testing.T) {
		res := runCli(t, dir, "search", "--status-check")
		requireSuccess(t, res)
		// Should mention model or enabled
		output := strings.ToLower(res.Stdout)
		if !strings.Contains(output, "all-minilm") && !strings.Contains(output, "enabled") {
			t.Logf("status check output: %s", res.Stdout)
		}
	})

	// Step 5: Reindex (120s timeout)
	t.Run("reindex", func(t *testing.T) {
		res := runCliWithTimeout(t, dir, 120*time.Second, "search", "--reindex")
		requireSuccess(t, res)
		output := strings.ToLower(res.Stdout)
		if !strings.Contains(output, "rebuilt") && !strings.Contains(output, "index") {
			t.Logf("reindex output: %s", res.Stdout)
		}
	})

	// Step 6: Semantic search for docs
	t.Run("semantic search docs", func(t *testing.T) {
		res := runCli(t, dir, "search", "authentication security", "--type", "doc", "--plain")
		if res.ExitCode > 1 {
			t.Fatalf("search failed with code %d: %s", res.ExitCode, res.Stderr)
		}
		t.Logf("semantic doc search: %s", truncate(res.Stdout, 300))
	})

	// Step 7: Semantic search for tasks
	t.Run("semantic search tasks", func(t *testing.T) {
		res := runCli(t, dir, "search", "JWT implementation", "--type", "task", "--plain")
		if res.ExitCode > 1 {
			t.Fatalf("search failed with code %d: %s", res.ExitCode, res.Stderr)
		}
		t.Logf("semantic task search: %s", truncate(res.Stdout, 300))
	})

	// Step 8: Keyword search should also work
	t.Run("keyword search", func(t *testing.T) {
		res := runCli(t, dir, "search", "Security Patterns", "--keyword", "--type", "doc", "--plain")
		if res.ExitCode > 1 {
			t.Fatalf("search failed with code %d: %s", res.ExitCode, res.Stderr)
		}
		t.Logf("keyword search: %s", truncate(res.Stdout, 300))
	})

	t.Run("search code only json", func(t *testing.T) {
		res := runCli(t, dir, "search", "authentication security patterns", "--type", "code", "--json", "--limit", "10")
		if res.ExitCode > 1 {
			t.Fatalf("search failed with code %d: %s", res.ExitCode, res.Stderr)
		}
		var parsed []map[string]any
		if err := json.Unmarshal([]byte(res.Stdout), &parsed); err != nil {
			t.Fatalf("parse json output: %v\n%s", err, res.Stdout)
		}
		for _, item := range parsed {
			if got, _ := item["type"].(string); got != "code" {
				t.Fatalf("expected only code results, got type=%q in %v", got, item)
			}
		}
	})

	// Step 9: Model status
	t.Run("model status", func(t *testing.T) {
		res := runCli(t, dir, "model", "status")
		requireSuccess(t, res)
	})
}

// TestCLI_Board tests the board command runs without error.
func TestCLI_Board(t *testing.T) {
	dir := setupTestProject(t)

	// Create a task so the board has something
	runCli(t, dir, "task", "create", "Board Test Task")

	t.Run("board runs", func(t *testing.T) {
		res := runCli(t, dir, "board")
		requireSuccess(t, res)
	})
}
