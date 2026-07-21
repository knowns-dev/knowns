package lspfixtures

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/lsp"
	"github.com/howznguyen/knowns/internal/lsp/adapters"
)

func TestLSPFixture_JSONLocalSchema(t *testing.T) {
	if os.Getenv("TEST_LSP_FIXTURES") != "1" {
		t.Skip("set TEST_LSP_FIXTURES=1 to run external LSP fixture smoke tests")
	}
	if selected := strings.TrimSpace(os.Getenv("TEST_LSP_FIXTURE")); selected != "" && selected != "json" {
		t.Skipf("TEST_LSP_FIXTURE selects %q", selected)
	}
	requireTool(t, "node")
	requireTool(t, "vscode-json-languageserver")

	projectDir := t.TempDir()
	schemaPath := filepath.Join(projectDir, "schema.json")
	configPath := filepath.Join(projectDir, "service.json")
	writeJSONFixtureFile(t, schemaPath, `{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "service": {
      "type": "object",
      "properties": {
        "name": {"type": "string"},
        "port": {"type": "integer"}
      },
      "required": ["name", "port"]
    }
  },
  "required": ["service"]
}`)
	writeJSONFixtureFile(t, configPath, fmt.Sprintf(`{
  "$schema": %q,
  "service": {
    "name": "payments",
    "port": "not-an-integer"
  }
	}`, lsp.FileURI(schemaPath)))
	writeJSONFixtureFile(t, filepath.Join(projectDir, "unsupported.jsonc"), "fixture_probe\n")
	env := testEnv(t)
	binary := knownsBinary(t)
	initKnownsProject(t, binary, projectDir, env)

	manager := lsp.NewManager(projectDir, lsp.Config{})
	if err := manager.RegisterAdapter(adapters.NewJSONAdapter()); err != nil {
		t.Fatalf("register JSON adapter: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = manager.StopAll(ctx)
	})

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	server, ok, err := manager.ServerForPath(ctx, configPath)
	if err != nil {
		t.Fatalf("start JSON server: %v", err)
	}
	if !ok || server == nil {
		t.Fatal("JSON server was not available for service.json")
	}
	symbols, err := server.DocumentSymbols(ctx, configPath)
	if err != nil {
		t.Fatalf("document symbols: %v", err)
	}
	if !containsJSONFixtureSymbol(symbols, "service") || !containsJSONFixtureSymbol(symbols, "port") {
		t.Fatalf("expected service and port symbols, got: %#v", symbols)
	}
	deadline := time.Now().Add(20 * time.Second)
	var schemaDiagnostics []lsp.Diagnostic
	diagnosticsReady := false
	for {
		diagnostics, err := server.Diagnostics(ctx, configPath)
		if err != nil {
			t.Fatalf("schema diagnostics: %v", err)
		}
		schemaDiagnostics = diagnostics
		for _, diagnostic := range diagnostics {
			if strings.Contains(strings.ToLower(diagnostic.Message), "integer") {
				diagnosticsReady = true
				break
			}
		}
		if diagnosticsReady {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("expected local-schema integer diagnostic, got: %#v; capabilities: %#v", diagnostics, server.CapabilitySnapshot())
		}
		time.Sleep(250 * time.Millisecond)
	}
	if len(schemaDiagnostics) == 0 {
		t.Fatal("expected non-empty JSON schema diagnostics")
	}
	if err := manager.StopAll(ctx); err != nil {
		t.Fatalf("stop direct JSON fixture server: %v", err)
	}

	client := startMCP(t, binary, projectDir, env)
	client.initialize(t)
	client.setProject(t, projectDir)
	client.callToolUntilRawContains(t, 60*time.Second, "service", "code", map[string]any{
		"action": "symbols",
		"path":   "service.json",
		"depth":  2,
	})
	client.callToolUntilRawContains(t, 60*time.Second, "integer", "code", map[string]any{
		"action": "diagnostics",
		"path":   "service.json",
	})
	status := requireLiveCapabilityStatus(t, client, "json", "document_symbols", "diagnostics")
	requireUnsupportedCodeAction(t, client, status, "unsupported.jsonc", "fixture_probe", "implementations", "implementation capability", true)
	client.close()
}

func writeJSONFixtureFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("write fixture %s: %v", path, err)
	}
}

func containsJSONFixtureSymbol(symbols []lsp.DocumentSymbol, name string) bool {
	for _, symbol := range symbols {
		if symbol.Name == name || containsJSONFixtureSymbol(symbol.Children, name) {
			return true
		}
	}
	return false
}
