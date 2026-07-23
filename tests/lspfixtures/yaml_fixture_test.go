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

func TestLSPFixture_YAMLLocalSchema(t *testing.T) {
	if os.Getenv("TEST_LSP_FIXTURES") != "1" {
		t.Skip("set TEST_LSP_FIXTURES=1 to run external LSP fixture smoke tests")
	}
	if selected := strings.TrimSpace(os.Getenv("TEST_LSP_FIXTURE")); selected != "" && selected != "yaml" {
		t.Skipf("TEST_LSP_FIXTURE selects %q", selected)
	}
	requireTool(t, "node")
	requireTool(t, "yaml-language-server")

	projectDir := t.TempDir()
	schemaPath := filepath.Join(projectDir, "service.schema.json")
	configPath := filepath.Join(projectDir, "service.yaml")
	writeYAMLFixtureFile(t, schemaPath, `{
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
	writeYAMLFixtureFile(t, configPath, fmt.Sprintf(strings.Join([]string{
		"# yaml-language-server: $schema=%s",
		"service:",
		"  name: payments",
		"  port: not-an-integer",
		"",
	}, "\n"), lsp.FileURI(schemaPath)))
	env := testEnv(t)
	binary := knownsBinary(t)
	initKnownsProject(t, binary, projectDir, env)

	manager := lsp.NewManager(projectDir, lsp.Config{})
	if err := manager.RegisterAdapter(adapters.NewYAMLAdapter()); err != nil {
		t.Fatalf("register YAML adapter: %v", err)
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
		t.Fatalf("start YAML server: %v", err)
	}
	if !ok || server == nil {
		t.Fatal("YAML server was not available for service.yaml")
	}

	symbols, err := server.DocumentSymbols(ctx, configPath)
	if err != nil {
		t.Fatalf("document symbols: %v", err)
	}
	if !containsYAMLFixtureSymbol(symbols, "service") || !containsYAMLFixtureSymbol(symbols, "port") {
		t.Fatalf("expected service and port symbols, got: %#v", symbols)
	}

	deadline := time.Now().Add(20 * time.Second)
	diagnosticsReady := false
	for {
		diagnostics, err := server.Diagnostics(ctx, configPath)
		if err != nil {
			t.Fatalf("schema diagnostics: %v", err)
		}
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
	if err := manager.StopAll(ctx); err != nil {
		t.Fatalf("stop direct YAML fixture server: %v", err)
	}

	client := startMCP(t, binary, projectDir, env)
	client.initialize(t)
	client.setProject(t, projectDir)
	client.callToolUntilRawContains(t, 60*time.Second, "service", "code", map[string]any{
		"action": "symbols",
		"path":   "service.yaml",
		"depth":  2,
	})
	client.callToolUntilRawContains(t, 60*time.Second, "integer", "code", map[string]any{
		"action": "diagnostics",
		"path":   "service.yaml",
	})
	status := requireLiveCapabilityStatus(t, client, "yaml", "document_symbols", "diagnostics")
	requireUnsupportedCodeAction(t, client, status, "service.yaml", "service", "implementations", "implementation capability", true)
	client.close()
}

func writeYAMLFixtureFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write fixture %s: %v", path, err)
	}
}

func containsYAMLFixtureSymbol(symbols []lsp.DocumentSymbol, name string) bool {
	for _, symbol := range symbols {
		if symbol.Name == name || containsYAMLFixtureSymbol(symbol.Children, name) {
			return true
		}
	}
	return false
}
