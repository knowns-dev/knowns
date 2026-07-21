package lspfixtures

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLSPFixture_MarkdownMarksman(t *testing.T) {
	if os.Getenv("TEST_LSP_FIXTURES") != "1" {
		t.Skip("set TEST_LSP_FIXTURES=1 to run external LSP fixture smoke tests")
	}
	requireTool(t, "marksman")

	env := testEnv(t)
	binary := knownsBinary(t)
	projectDir := t.TempDir()
	writeMarkdownFixture(t, filepath.Join(projectDir, ".marksman.toml"), "")
	writeMarkdownFixture(t, filepath.Join(projectDir, "README.md"), strings.Join([]string{
		"# Markdown Fixture",
		"",
		"## Overview",
		"",
		"This unresolved wiki link must be diagnosed: [[missing-note]].",
	}, "\n"))
	writeMarkdownFixture(t, filepath.Join(projectDir, "existing-note.md"), "# Existing Note\n")

	result := runCmd(t, projectDir, 60*time.Second, env, binary, "init", "lsp-fixture-markdown", "--no-wizard", "--no-open", "--git-ignored")
	if result.err != nil {
		t.Fatalf("knowns init failed: %v\nstdout: %s\nstderr: %s", result.err, result.stdout, result.stderr)
	}

	client := startMCP(t, binary, projectDir, env)
	client.initialize(t)
	client.setProject(t, projectDir)
	client.callToolUntilRawContains(t, 60*time.Second, "Overview", "code", map[string]any{
		"action": "symbols",
		"path":   "README.md",
		"depth":  2,
	})
	diagnostics := client.callToolUntilRawContains(t, 60*time.Second, "missing-note", "code", map[string]any{
		"action": "diagnostics",
		"path":   "README.md",
	})
	if !strings.Contains(diagnostics.raw, "Link to non-existent document") {
		t.Fatalf("expected Marksman broken-link diagnostic, got: %s", diagnostics.raw)
	}
	status := requireLiveCapabilityStatus(t, client, "markdown", "document_symbols", "diagnostics")
	requireUnsupportedCodeAction(t, client, status, "README.md", "Overview", "implementations", "implementation capability", true)
	client.close()
}

func writeMarkdownFixture(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("write Markdown fixture %s: %v", path, err)
	}
}
