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

func TestLSPFixture_Terraform(t *testing.T) {
	if os.Getenv("TEST_LSP_FIXTURES") != "1" {
		t.Skip("set TEST_LSP_FIXTURES=1 to run external LSP fixture smoke tests")
	}
	if selected := strings.TrimSpace(os.Getenv("TEST_LSP_FIXTURE")); selected != "" && selected != "terraform" {
		t.Skipf("TEST_LSP_FIXTURE selects %q", selected)
	}
	requireTool(t, "terraform-ls")
	requireTool(t, "terraform")

	projectDir := t.TempDir()
	mainPath := filepath.Join(projectDir, "main.tf")
	writeTerraformFixture(t, mainPath, strings.Join([]string{
		`variable "fixture_name" {`,
		`  type = string`,
		`}`,
		``,
		`locals {`,
		`  fixture_value = var.fixture_name`,
		`}`,
		``,
		`output "fixture_output" {`,
		`  value = local.fixture_value`,
		`}`,
		``,
		`output "fixture_copy" {`,
		`  value = local.fixture_value`,
		`}`,
		``,
	}, "\n"))
	env := testEnv(t)
	binary := knownsBinary(t)
	initKnownsProject(t, binary, projectDir, env)

	manager := lsp.NewManager(projectDir, lsp.Config{})
	if err := manager.RegisterAdapter(adapters.NewTerraformLSAdapter()); err != nil {
		t.Fatalf("register Terraform adapter: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = manager.StopAll(ctx)
	})

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	server, ok, err := manager.ServerForPath(ctx, mainPath)
	if err != nil {
		t.Fatalf("start terraform-ls: %v", err)
	}
	if !ok || server == nil {
		t.Fatal("terraform-ls was not available for main.tf")
	}
	symbols, err := server.DocumentSymbols(ctx, mainPath)
	if err != nil {
		t.Fatalf("document symbols: %v", err)
	}
	for _, name := range []string{"fixture_name", "fixture_output", "fixture_copy"} {
		if !containsTerraformFixtureSymbol(symbols, name) {
			t.Errorf("document symbols missing %q: %#v", name, symbols)
		}
	}

	definition, err := waitForTerraformDefinition(ctx, server, mainPath, 9, 20)
	if err != nil {
		t.Fatalf("definition for local.fixture_value: %v", err)
	}
	if !lsp.SameFileURI(definition.URI, mainPath) || definition.Range.Start.Line != 5 {
		t.Fatalf("definition = %#v, want local fixture_value on line 5", definition)
	}

	references, err := waitForTerraformReferences(ctx, server, mainPath, 5, 4, 2)
	if err != nil {
		t.Fatalf("references for fixture_value: %v", err)
	}
	if len(references) < 2 {
		t.Fatalf("references = %#v, want both output uses", references)
	}
	for _, reference := range references {
		if !lsp.SameFileURI(reference.URI, mainPath) {
			t.Fatalf("reference = %#v, want main.tf", reference)
		}
	}
	if err := manager.StopAll(ctx); err != nil {
		t.Fatalf("stop direct Terraform fixture server: %v", err)
	}
	jsonPath := filepath.Join(projectDir, "generated.tf.json")
	writeTerraformFixture(t, jsonPath, "fixture_value\n")

	client := startMCP(t, binary, projectDir, env)
	client.initialize(t)
	client.setProject(t, projectDir)
	client.callToolUntilRawContains(t, 60*time.Second, "fixture_name", "code", map[string]any{
		"action": "symbols",
		"path":   "main.tf",
		"depth":  2,
	})
	status := requireLiveCapabilityStatus(t, client, "terraform", "document_symbols", "definition", "references")
	requireUnsupportedCodeAction(t, client, status, "generated.tf.json", "fixture_value", "definition", "Terraform JSON configuration", false)
	client.close()
}

func writeTerraformFixture(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("write Terraform fixture %s: %v", path, err)
	}
}

func containsTerraformFixtureSymbol(symbols []lsp.DocumentSymbol, name string) bool {
	for _, symbol := range symbols {
		if strings.Contains(symbol.Name, name) || containsTerraformFixtureSymbol(symbol.Children, name) {
			return true
		}
	}
	return false
}

func waitForTerraformDefinition(ctx context.Context, server *lsp.Server, path string, line, col int) (lsp.Location, error) {
	var lastErr error
	for ctx.Err() == nil {
		location, err := server.Definition(ctx, path, line, col)
		if err == nil {
			return location, nil
		}
		lastErr = err
		time.Sleep(250 * time.Millisecond)
	}
	return lsp.Location{}, lastErr
}

func waitForTerraformReferences(ctx context.Context, server *lsp.Server, path string, line, col, minimum int) ([]lsp.Location, error) {
	return waitForTerraformReferencesQuery(ctx, minimum, func(queryCtx context.Context) ([]lsp.Location, error) {
		return server.References(queryCtx, path, line, col)
	})
}

func waitForTerraformReferencesQuery(ctx context.Context, minimum int, query func(context.Context) ([]lsp.Location, error)) ([]lsp.Location, error) {
	var lastErr error
	var lastLocations []lsp.Location
	for ctx.Err() == nil {
		locations, err := query(ctx)
		lastLocations = locations
		if err == nil && len(locations) >= minimum {
			return locations, nil
		}
		lastErr = err
		timer := time.NewTimer(250 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
		case <-timer.C:
		}
	}
	if lastErr != nil {
		return lastLocations, fmt.Errorf("wait for at least %d Terraform references (last count %d): %w", minimum, len(lastLocations), lastErr)
	}
	return lastLocations, fmt.Errorf("wait for at least %d Terraform references: got %d before timeout: %w", minimum, len(lastLocations), ctx.Err())
}

func TestWaitForTerraformReferencesQueryReportsInsufficientResults(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	locations, err := waitForTerraformReferencesQuery(ctx, 2, func(context.Context) ([]lsp.Location, error) {
		return []lsp.Location{{URI: "file:///main.tf"}}, nil
	})
	if err == nil || !strings.Contains(err.Error(), "got 1 before timeout") {
		t.Fatalf("wait error = %v, want descriptive insufficient-reference timeout", err)
	}
	if len(locations) != 1 {
		t.Fatalf("locations = %#v, want last partial result", locations)
	}
}
