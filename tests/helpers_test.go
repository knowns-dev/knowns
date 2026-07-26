package tests

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------- CLI Helpers ----------

// CLIResult holds the output from a CLI command.
type CLIResult struct {
	Stdout   string
	Stderr   string
	ExitCode int
}

var ensureBinaryOnce sync.Once

// getBinaryPath returns the absolute path to the knowns binary.
// Respects TEST_BINARY env var; defaults to ../bin/knowns relative to this source file.
func getBinaryPath(t *testing.T) string {
	t.Helper()
	if p := os.Getenv("TEST_BINARY"); p != "" {
		abs, err := filepath.Abs(p)
		if err != nil {
			t.Fatalf("cannot resolve TEST_BINARY: %v", err)
		}
		return abs
	}
	// Resolve relative to this source file's directory.
	// When go test runs, the working dir is the package dir (tests/),
	// so ../bin/knowns should work, but let's make it absolute.
	binaryName := "knowns"
	if runtime.GOOS == "windows" {
		binaryName += ".exe"
	}
	rel := filepath.Join("..", "bin", binaryName)
	abs, err := filepath.Abs(rel)
	if err != nil {
		t.Fatalf("cannot resolve binary path: %v", err)
	}
	if _, err := os.Stat(abs); err != nil {
		ensureTestBinary(t, abs)
	}
	return abs
}

func ensureTestBinary(t *testing.T, abs string) {
	t.Helper()

	var buildErr error
	ensureBinaryOnce.Do(func() {
		repoRoot := filepath.Dir(filepath.Dir(abs))
		if err := os.MkdirAll(filepath.Dir(abs), 0755); err != nil {
			buildErr = fmt.Errorf("create bin dir: %w", err)
			return
		}

		cmd := exec.Command("go", "build", "-o", abs, "./cmd/knowns")
		cmd.Dir = repoRoot
		output, err := cmd.CombinedOutput()
		if err != nil {
			buildErr = fmt.Errorf("build test binary: %w\n%s", err, strings.TrimSpace(string(output)))
			return
		}
	})

	if buildErr != nil {
		t.Fatalf("binary not available at %s: %v", abs, buildErr)
	}
	if _, err := os.Stat(abs); err != nil {
		t.Fatalf("binary not found at %s after build: %v", abs, err)
	}
}

// setupTestProject creates an isolated temp directory with git init + knowns init.
// Returns the project dir. Cleanup is automatic via t.Cleanup.
func setupTestProject(t *testing.T) string {
	t.Helper()

	dir := t.TempDir() // automatically cleaned up

	// git init
	cmd := exec.Command("git", "init")
	cmd.Dir = dir
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		t.Fatalf("git init failed: %v", err)
	}

	// Configure git user for the test repo
	for _, kv := range [][2]string{
		{"user.email", "test@e2e.local"},
		{"user.name", "E2E Test"},
	} {
		c := exec.Command("git", "config", kv[0], kv[1])
		c.Dir = dir
		_ = c.Run()
	}

	// knowns init
	res := runCli(t, dir, "init", "e2e-test", "--no-wizard")
	if res.ExitCode != 0 {
		t.Fatalf("knowns init failed (code %d): %s\n%s", res.ExitCode, res.Stderr, res.Stdout)
	}

	return dir
}

// runCli executes the knowns binary with the given args inside dir.
// Timeout is 60 seconds.
func runCli(t *testing.T, dir string, args ...string) CLIResult {
	t.Helper()
	return runCliWithTimeout(t, dir, 60*time.Second, args...)
}

// runCliWithTimeout is like runCli but with a custom timeout.
func runCliWithTimeout(t *testing.T, dir string, timeout time.Duration, args ...string) CLIResult {
	t.Helper()

	bin := getBinaryPath(t)
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "NO_COLOR=1", "KNOWNS_RUNTIME_INLINE=1")

	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()

	code := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			code = exitErr.ExitCode()
		} else {
			code = -1
		}
	}

	return CLIResult{
		Stdout:   stdout.String(),
		Stderr:   stderr.String(),
		ExitCode: code,
	}
}

// taskIDRegex matches "task-<id>" format (e.g., "task-abc123").
var taskIDRegex = regexp.MustCompile(`task-([a-z0-9]+)`)

// createdTaskRegex matches the Go CLI create output: "Created task <id>:" (with optional ANSI codes).
var createdTaskRegex = regexp.MustCompile(`(?i)created\s+task\s+([a-z0-9]+)`)

// extractTaskID extracts the first task-<id> from the given text (e.g. "task-abc123").
func extractTaskID(output string) string {
	match := taskIDRegex.FindString(output)
	return match
}

// extractTaskIDShort extracts just the short ID from output.
// Tries multiple patterns:
// 1. "Created task <id>:" from CLI create output
// 2. "task-<id>" reference format
func extractTaskIDShort(output string) string {
	// Strip ANSI escape codes
	ansiRegex := regexp.MustCompile(`\x1b\[[0-9;]*m`)
	clean := ansiRegex.ReplaceAllString(output, "")

	// Try "Created task <id>:" pattern first
	matches := createdTaskRegex.FindStringSubmatch(clean)
	if len(matches) >= 2 {
		return matches[1]
	}

	// Fall back to "task-<id>" pattern
	matches = taskIDRegex.FindStringSubmatch(clean)
	if len(matches) >= 2 {
		return matches[1]
	}

	return ""
}

// requireSuccess asserts that the CLI returned exit code 0.
func requireSuccess(t *testing.T, res CLIResult, msgAndArgs ...string) {
	t.Helper()
	if res.ExitCode != 0 {
		extra := ""
		if len(msgAndArgs) > 0 {
			extra = ": " + strings.Join(msgAndArgs, " ")
		}
		t.Fatalf("expected exit code 0, got %d%s\nstdout: %s\nstderr: %s",
			res.ExitCode, extra, truncate(res.Stdout, 500), truncate(res.Stderr, 500))
	}
}

// ---------- MCP Helpers ----------

// MCPClient manages a child MCP server process communicating via stdio JSON-RPC.
type MCPClient struct {
	t      *testing.T
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	reader *bufio.Reader
	nextID int
	mu     sync.Mutex
}

// startMCPServer spawns "knowns mcp" and returns a client.
func startMCPServer(t *testing.T) *MCPClient {
	t.Helper()

	bin := getBinaryPath(t)
	cmd := exec.Command(bin, "mcp")
	cmd.Env = append(os.Environ(), "NO_COLOR=1", "KNOWNS_RUNTIME_INLINE=1")

	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatalf("stdin pipe: %v", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("stdout pipe: %v", err)
	}
	cmd.Stderr = io.Discard

	if err := cmd.Start(); err != nil {
		t.Fatalf("start MCP server: %v", err)
	}

	client := &MCPClient{
		t:      t,
		cmd:    cmd,
		stdin:  stdin,
		reader: bufio.NewReader(stdout),
		nextID: 1,
	}

	t.Cleanup(func() {
		client.Close()
	})

	// Give the server a moment to start
	time.Sleep(500 * time.Millisecond)

	return client
}

// sendRequest sends a JSON-RPC request and reads the response.
func (c *MCPClient) sendRequest(method string, params any) (map[string]any, error) {
	c.mu.Lock()
	id := c.nextID
	c.nextID++
	c.mu.Unlock()

	req := map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
		"params":  params,
	}

	data, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	if _, err := c.stdin.Write(append(data, '\n')); err != nil {
		return nil, fmt.Errorf("write request: %w", err)
	}

	// Read responses until we find ours
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		line, err := c.reader.ReadString('\n')
		if err != nil {
			return nil, fmt.Errorf("read response: %w", err)
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		var resp map[string]any
		if err := json.Unmarshal([]byte(line), &resp); err != nil {
			continue
		}

		respID, _ := resp["id"].(float64)
		if int(respID) == id {
			return resp, nil
		}
	}

	return nil, fmt.Errorf("timeout waiting for response to request %d", id)
}

// Initialize sends the MCP initialize handshake.
func (c *MCPClient) Initialize() {
	c.t.Helper()
	c.InitializeRaw()
}

// InitializeRaw sends the MCP initialize handshake and returns the full response.
func (c *MCPClient) InitializeRaw() map[string]any {
	c.t.Helper()
	resp, err := c.sendRequest("initialize", map[string]any{
		"protocolVersion": "2024-11-05",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "e2e-test", "version": "1.0.0"},
	})
	if err != nil {
		c.t.Fatalf("MCP initialize failed: %v", err)
	}
	if resp["error"] != nil {
		c.t.Fatalf("MCP initialize error: %v", resp["error"])
	}
	return resp
}

// SetProject sets the active project directory.
func (c *MCPClient) SetProject(dir string) {
	c.t.Helper()
	result := c.CallTool("project", map[string]any{
		"action":      "set",
		"projectRoot": dir,
	})
	if success, ok := result["success"].(bool); !ok || !success {
		c.t.Fatalf("project set failed: %v", result)
	}
}

// CallTool calls an MCP tool and returns the parsed JSON result.
// For object responses, returns the parsed map.
// For array responses, returns {"_array": [...], "_raw": "..."}.
func (c *MCPClient) CallTool(name string, args map[string]any) map[string]any {
	c.t.Helper()
	args = fullMutationResponseArgs(name, args)

	resp, err := c.sendRequest("tools/call", map[string]any{
		"name":      name,
		"arguments": args,
	})
	if err != nil {
		c.t.Fatalf("MCP tool call %q failed: %v", name, err)
	}

	if errObj, ok := resp["error"]; ok && errObj != nil {
		c.t.Fatalf("MCP error calling %q: %v", name, errObj)
	}

	result, ok := resp["result"].(map[string]any)
	if !ok {
		c.t.Fatalf("unexpected result format for %q: %v", name, resp)
	}
	content, ok := result["content"].([]any)
	if !ok || len(content) == 0 {
		c.t.Fatalf("no content in response for %q", name)
	}
	first, ok := content[0].(map[string]any)
	if !ok {
		c.t.Fatalf("unexpected content format for %q", name)
	}
	text, ok := first["text"].(string)
	if !ok {
		c.t.Fatalf("no text in content for %q", name)
	}

	var parsed map[string]any
	if err := json.Unmarshal([]byte(text), &parsed); err != nil {
		// Might be an array response (list_tasks, search)
		var arr []any
		if err2 := json.Unmarshal([]byte(text), &arr); err2 != nil {
			c.t.Fatalf("cannot parse tool result for %q: %v\nraw: %s", name, err, text)
		}
		return map[string]any{"_array": arr, "_raw": text}
	}
	return parsed
}

// fullMutationResponseArgs keeps the high-level E2E helper's historical
// full-entity contract after task/doc mutations became summary-by-default.
// Tests that exercise the compact wire response use CallToolRaw directly.
func fullMutationResponseArgs(name string, args map[string]any) map[string]any {
	action, _ := args["action"].(string)
	if (name != "tasks" && name != "docs") || (action != "create" && action != "update") {
		return args
	}
	if _, explicit := args["return"]; explicit {
		return args
	}
	withReturn := make(map[string]any, len(args)+1)
	for key, value := range args {
		withReturn[key] = value
	}
	withReturn["return"] = "full"
	return withReturn
}

// CallToolRaw calls an MCP tool and returns the raw JSON text.
func (c *MCPClient) CallToolRaw(name string, args map[string]any) string {
	c.t.Helper()

	resp, err := c.sendRequest("tools/call", map[string]any{
		"name":      name,
		"arguments": args,
	})
	if err != nil {
		c.t.Fatalf("MCP tool call %q failed: %v", name, err)
	}

	if errObj, ok := resp["error"]; ok && errObj != nil {
		c.t.Fatalf("MCP error calling %q: %v", name, errObj)
	}

	result, ok := resp["result"].(map[string]any)
	if !ok {
		return ""
	}
	content, ok := result["content"].([]any)
	if !ok || len(content) == 0 {
		return ""
	}
	first, ok := content[0].(map[string]any)
	if !ok {
		return ""
	}
	text, _ := first["text"].(string)
	return text
}

// Close terminates the MCP server process.
func (c *MCPClient) Close() {
	if c.cmd != nil && c.cmd.Process != nil {
		_ = c.stdin.Close()
		_ = c.cmd.Process.Signal(os.Interrupt)
		done := make(chan error, 1)
		go func() { done <- c.cmd.Wait() }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			_ = c.cmd.Process.Kill()
		}
	}
}

// ---------- Assertion Helpers ----------

// assertContains checks that haystack contains needle.
func assertContains(t *testing.T, haystack, needle string, msgAndArgs ...string) {
	t.Helper()
	if !strings.Contains(haystack, needle) {
		extra := ""
		if len(msgAndArgs) > 0 {
			extra = ": " + strings.Join(msgAndArgs, " ")
		}
		t.Errorf("expected output to contain %q%s\ngot: %s", needle, extra, truncate(haystack, 500))
	}
}

// truncate limits a string to maxLen characters.
func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
