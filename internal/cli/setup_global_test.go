package cli

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSetupGlobalClaudeCodeMCPUsesClaudeUserConfig(t *testing.T) {
	home := t.TempDir()
	execLookPath = func(string) (string, error) { return "/usr/local/bin/knowns", nil }
	t.Cleanup(func() { execLookPath = defaultExecLookPath })

	configPath := filepath.Join(home, ".claude.json")
	writeJSONFile(t, configPath, map[string]any{
		"theme": "dark",
		"mcpServers": map[string]any{
			"existing": map[string]any{
				"command": "existing-mcp",
			},
		},
	})

	if err := setupGlobalClaudeCodeMCP(home); err != nil {
		t.Fatalf("setupGlobalClaudeCodeMCP returned error: %v", err)
	}

	config := readJSONFile(t, configPath)
	if got := config["theme"]; got != "dark" {
		t.Fatalf("expected existing config field to be preserved, got %#v", got)
	}

	servers := getMap(t, config, "mcpServers")
	existing := getMap(t, servers, "existing")
	if got := existing["command"]; got != "existing-mcp" {
		t.Fatalf("expected existing MCP server to be preserved, got %#v", got)
	}

	knowns := getMap(t, servers, "knowns")
	if got := knowns["command"]; got != "knowns" {
		t.Fatalf("expected knowns MCP command, got %#v", got)
	}
	args, ok := knowns["args"].([]any)
	if !ok {
		t.Fatalf("expected knowns MCP args to be []any, got %T", knowns["args"])
	}
	wantArgs := []string{"mcp", "--stdio"}
	if len(args) != len(wantArgs) {
		t.Fatalf("expected %d knowns MCP args, got %d", len(wantArgs), len(args))
	}
	for i, want := range wantArgs {
		if args[i] != want {
			t.Fatalf("expected knowns MCP arg %d to be %q, got %#v", i, want, args[i])
		}
	}

	legacyPath := filepath.Join(home, ".claude", "settings.json")
	if _, err := os.Stat(legacyPath); !os.IsNotExist(err) {
		t.Fatalf("expected legacy Claude settings path to remain absent, got err: %v", err)
	}
}
