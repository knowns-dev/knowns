package handlers

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/lsp"
	"github.com/howznguyen/knowns/internal/lsp/adapters"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/mark3labs/mcp-go/mcp"
)

func TestLSPPathRequestNoProject(t *testing.T) {
	req := mcp.CallToolRequest{Params: mcp.CallToolParams{Arguments: map[string]any{"path": "main.go"}}}
	_, _, _, err := lspPathRequest(t.Context(), func() *storage.Store { return nil }, nil, req)
	if err == nil || !strings.Contains(err.Error(), "no project loaded") {
		t.Fatalf("error = %v", err)
	}
}

func TestLSPSeverity(t *testing.T) {
	cases := map[int]string{1: "error", 2: "warning", 3: "info", 4: "hint", 0: "error"}
	for in, want := range cases {
		if got := lspSeverity(in); got != want {
			t.Fatalf("severity %d = %q, want %q", in, got, want)
		}
	}
}

func TestFindSymbolByNameExactSignature(t *testing.T) {
	symbols := []lsp.DocumentSymbol{
		{
			Name: "SearchEndpoints",
			Kind: 5,
			Children: []lsp.DocumentSymbol{
				{Name: "MapSearchEndpoints(this IEndpointRouteBuilder routes)", Kind: 6},
			},
		},
	}

	got, ok, err := findSymbolByName(symbols, "SearchEndpoints.MapSearchEndpoints(this IEndpointRouteBuilder routes)")
	if err != nil {
		t.Fatal(err)
	}
	if !ok || got.Name != "MapSearchEndpoints(this IEndpointRouteBuilder routes)" {
		t.Fatalf("findSymbolByName exact signature = (%q, %v), want method", got.Name, ok)
	}
}

func TestFindSymbolByNameBareCallableUnique(t *testing.T) {
	symbols := []lsp.DocumentSymbol{
		{
			Name: "SearchEndpoints",
			Kind: 5,
			Children: []lsp.DocumentSymbol{
				{Name: "MapSearchEndpoints(this IEndpointRouteBuilder routes)", Kind: 6},
			},
		},
	}

	got, ok, err := findSymbolByName(symbols, "MapSearchEndpoints")
	if err != nil {
		t.Fatal(err)
	}
	if !ok || got.Name != "MapSearchEndpoints(this IEndpointRouteBuilder routes)" {
		t.Fatalf("findSymbolByName bare method = (%q, %v), want signature method", got.Name, ok)
	}
}

func TestFindSymbolByNameBareCallableAmbiguous(t *testing.T) {
	symbols := []lsp.DocumentSymbol{
		{
			Name: "SearchEndpoints",
			Kind: 5,
			Children: []lsp.DocumentSymbol{
				{Name: "MapSearchEndpoints(this IEndpointRouteBuilder routes)", Kind: 6},
			},
		},
		{
			Name: "SearchEndpointExtensions",
			Kind: 5,
			Children: []lsp.DocumentSymbol{
				{Name: "MapSearchEndpoints(WebApplication app)", Kind: 6},
			},
		},
	}

	_, ok, err := findSymbolByName(symbols, "MapSearchEndpoints")
	if err == nil || !strings.Contains(err.Error(), "ambiguous") {
		t.Fatalf("findSymbolByName ambiguous error = %v, want ambiguity", err)
	}
	if ok {
		t.Fatal("findSymbolByName ambiguous ok = true, want false")
	}
}

func TestReplaceLinesTreatsEndLineAsExclusive(t *testing.T) {
	path := filepath.Join(t.TempDir(), "SearchEndpoints.cs")
	source := strings.Join([]string{
		"namespace Demo",
		"{",
		"    public static class SearchEndpoints",
		"    {",
		"        public static void MapSearchEndpoints()",
		"        {",
		"            OldBody();",
		"        }",
		"    }",
		"}",
	}, "\n")
	if err := os.WriteFile(path, []byte(source), 0644); err != nil {
		t.Fatal(err)
	}

	replaced, err := replaceLines(path, 4, 8, strings.Join([]string{
		"        public static void MapSearchEndpoints()",
		"        {",
		"            NewBody();",
		"        }",
	}, "\n"))
	if err != nil {
		t.Fatal(err)
	}
	if replaced != 4 {
		t.Fatalf("replaced = %d, want 4", replaced)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	want := strings.Join([]string{
		"namespace Demo",
		"{",
		"    public static class SearchEndpoints",
		"    {",
		"        public static void MapSearchEndpoints()",
		"        {",
		"            NewBody();",
		"        }",
		"    }",
		"}",
	}, "\n")
	if got := string(data); got != want {
		t.Fatalf("file after replaceLines:\n%s\nwant:\n%s", got, want)
	}
}

func TestLSPPathRequestNoManager(t *testing.T) {
	req := mcp.CallToolRequest{Params: mcp.CallToolParams{Arguments: map[string]any{"path": "main.go"}}}
	store := storage.NewStore(t.TempDir())
	_, _, _, err := lspPathRequest(t.Context(), func() *storage.Store { return store }, nil, req)
	if err == nil || !strings.Contains(err.Error(), "LSP not available for this project") {
		t.Fatalf("error = %v", err)
	}
}

func TestLSPPathRequestRequiresPath(t *testing.T) {
	req := mcp.CallToolRequest{Params: mcp.CallToolParams{Arguments: map[string]any{}}}
	store := storage.NewStore(t.TempDir())
	_, _, _, err := lspPathRequest(t.Context(), func() *storage.Store { return store }, func() *lsp.Manager { return nil }, req)
	if err == nil || !strings.Contains(err.Error(), "LSP not available for this project") {
		t.Fatalf("error = %v", err)
	}
}

func TestCodeSymbolsCSharpStartupFailureReturnsStructuredRuntimeError(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".knowns"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "Program.cs"), []byte("class Program {}"), 0644); err != nil {
		t.Fatal(err)
	}
	store := storage.NewStore(filepath.Join(root, ".knowns"))
	mgr := lsp.NewManager(root, lsp.Config{Languages: map[string]lsp.LanguageConfig{
		lsp.CSharpLanguageID: {Backend: lsp.CSharpBackendRoslyn},
	}})
	mgr.RegisterAdapter(adapters.NewRoslynAdapter())
	detector := lsp.NewDetector(nil)
	detector.LookPath = func(string) (string, error) { return "", errors.New("missing") }
	detector.Installer = lsp.NewInstaller(t.TempDir())
	mgr.SetDetector(detector)

	req := mcp.CallToolRequest{Params: mcp.CallToolParams{Arguments: map[string]any{
		"path": "Program.cs",
	}}}
	result, err := handleCodeSymbols(t.Context(), func() *storage.Store { return store }, func() *lsp.Manager { return mgr }, req)
	if err != nil {
		t.Fatal(err)
	}
	if result == nil || !result.IsError || len(result.Content) != 1 {
		t.Fatalf("unexpected result: %#v", result)
	}
	text, ok := result.Content[0].(mcp.TextContent)
	if !ok {
		t.Fatalf("unexpected content: %#v", result.Content[0])
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(text.Text), &payload); err != nil {
		t.Fatalf("error payload is not JSON: %s", text.Text)
	}
	if payload["error"] != "csharp_backend_unavailable" {
		t.Fatalf("payload error = %#v, want csharp_backend_unavailable; payload=%#v", payload["error"], payload)
	}
	if payload["remediation"] == "" || payload["log_path"] == "" {
		t.Fatalf("payload missing actionable fields: %#v", payload)
	}
	if strings.Contains(text.Text, "EOF") {
		t.Fatalf("payload should not be bare EOF: %s", text.Text)
	}
}
