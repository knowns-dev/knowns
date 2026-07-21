package lspfixtures

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLSPFixture_Bash(t *testing.T) {
	if os.Getenv("TEST_LSP_FIXTURES") != "1" {
		t.Skip("set TEST_LSP_FIXTURES=1 to run external LSP fixture smoke tests")
	}
	requireTool(t, "bash-language-server")

	env := testEnv(t)
	binary := knownsBinary(t)
	projectDir := t.TempDir()
	writeBashFixture(t, projectDir)
	initKnownsProject(t, binary, projectDir, env)

	client := startMCP(t, binary, projectDir, env)
	client.initialize(t)
	client.setProject(t, projectDir)

	client.callToolUntilRawContains(t, 90*time.Second, "fixture_greet", "code", map[string]any{
		"action": "symbols",
		"path":   "lib.sh",
		"depth":  2,
	})

	definition := client.callToolUntilRawContains(t, 90*time.Second, "lib.sh", "code", map[string]any{
		"action": "definition",
		"path":   "main.sh",
		"query":  "fixture_greet",
	})
	if file, _ := definition.object["file"].(string); !strings.HasSuffix(filepath.ToSlash(file), "/lib.sh") && file != "lib.sh" {
		t.Fatalf("definition returned unexpected file: %s\nraw: %s", file, definition.raw)
	}

	references := client.callToolUntilRawContains(t, 90*time.Second, "main.sh", "code", map[string]any{
		"action": "references",
		"path":   "lib.sh",
		"query":  "fixture_greet",
	})
	if len(references.array) == 0 {
		t.Fatalf("expected references for fixture_greet, got: %s", references.raw)
	}
	status := requireLiveCapabilityStatus(t, client, "bash", "document_symbols", "definition", "references")
	requireUnsupportedCodeAction(t, client, status, "lib.sh", "fixture_greet", "implementations", "implementation capability", true)
}

func writeBashFixture(t *testing.T, projectDir string) {
	t.Helper()
	files := map[string]string{
		"lib.sh": strings.Join([]string{
			"#!/usr/bin/env bash",
			"fixture_greet() {",
			"  printf 'hello %s\\n' \"$1\"",
			"}",
			"",
		}, "\n"),
		"main.sh": strings.Join([]string{
			"#!/usr/bin/env bash",
			"source ./lib.sh",
			"fixture_greet \"Knowns\"",
			"",
		}, "\n"),
	}
	for name, content := range files {
		path := filepath.Join(projectDir, name)
		if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
			t.Fatalf("write Bash fixture %s: %v", name, err)
		}
	}
}
