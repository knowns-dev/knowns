package handlers

import (
	"context"
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
	called := 0
	_, _, _, err := lspPathRequest(t.Context(), func() *storage.Store { return store }, func() CodeRuntime {
		called++
		return nil
	}, req)
	if err == nil || !strings.Contains(err.Error(), "path is required") {
		t.Fatalf("error = %v", err)
	}
	if called != 0 {
		t.Fatalf("runtime provider called %d times for invalid request, want 0", called)
	}
}

func TestCodeSymbolsUsesRuntimeBoundaryPreservingOutputShape(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".knowns"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "main.go"), []byte("package main\n\nfunc main() {}\n"), 0644); err != nil {
		t.Fatal(err)
	}
	store := storage.NewStore(filepath.Join(root, ".knowns"))
	runtime := &fakeCodeRuntime{
		session: fakeCodeSession{symbols: []lsp.DocumentSymbol{{
			Name: "main",
			Kind: 12,
			Range: lsp.Range{
				Start: lsp.Position{Line: 2, Character: 0},
				End:   lsp.Position{Line: 2, Character: 14},
			},
			SelectionRange: lsp.Range{
				Start: lsp.Position{Line: 2, Character: 5},
				End:   lsp.Position{Line: 2, Character: 9},
			},
		}}},
	}
	req := mcp.CallToolRequest{Params: mcp.CallToolParams{Arguments: map[string]any{
		"path": "main.go",
	}}}

	result, err := handleCodeSymbols(t.Context(), func() *storage.Store { return store }, func() CodeRuntime { return runtime }, req)
	if err != nil {
		t.Fatal(err)
	}
	if len(runtime.paths) != 1 || runtime.paths[0] != filepath.Join(root, "main.go") {
		t.Fatalf("runtime paths = %#v, want one main.go call", runtime.paths)
	}
	if result == nil || result.IsError || len(result.Content) != 1 {
		t.Fatalf("unexpected result: %#v", result)
	}
	text, ok := result.Content[0].(mcp.TextContent)
	if !ok {
		t.Fatalf("unexpected content: %#v", result.Content[0])
	}
	var payload map[string][]string
	if err := json.Unmarshal([]byte(text.Text), &payload); err != nil {
		t.Fatalf("payload is not grouped symbols JSON: %s", text.Text)
	}
	if got := payload["Function"]; len(got) != 1 || got[0] != "main" {
		t.Fatalf("Function symbols = %#v, want [main]", got)
	}
}

func TestCodeFindDirectoryUsesLSPSymbolsForKeywordSearch(t *testing.T) {
	root := t.TempDir()
	srcDir := filepath.Join(root, "src")
	if err := os.MkdirAll(filepath.Join(root, ".knowns"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(srcDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(srcDir, "main.go"), []byte(`package main

func main() {
	needle := "keyword lsp corpus"
	_ = needle
}
`), 0644); err != nil {
		t.Fatal(err)
	}
	store := storage.NewStore(filepath.Join(root, ".knowns"))
	runtime := &fakeCodeRuntime{
		session: fakeCodeSession{symbols: []lsp.DocumentSymbol{{
			Name: "main",
			Kind: 12,
			Range: lsp.Range{
				Start: lsp.Position{Line: 2, Character: 0},
				End:   lsp.Position{Line: 5, Character: 1},
			},
			SelectionRange: lsp.Range{
				Start: lsp.Position{Line: 2, Character: 5},
				End:   lsp.Position{Line: 2, Character: 9},
			},
		}}},
	}
	req := mcp.CallToolRequest{Params: mcp.CallToolParams{Arguments: map[string]any{
		"query": "main",
		"path":  "src",
		"limit": 5,
	}}}

	result, err := handleCodeFind(t.Context(), func() *storage.Store { return store }, func() CodeRuntime { return runtime }, req)
	if err != nil {
		t.Fatal(err)
	}
	if len(runtime.paths) != 1 || runtime.paths[0] != filepath.Join(srcDir, "main.go") {
		t.Fatalf("runtime paths = %#v, want one src/main.go call", runtime.paths)
	}
	if result == nil || result.IsError || len(result.Content) != 1 {
		t.Fatalf("unexpected result: %#v", result)
	}
	text, ok := result.Content[0].(mcp.TextContent)
	if !ok {
		t.Fatalf("unexpected content: %#v", result.Content[0])
	}
	var payload struct {
		Mode    string `json:"mode"`
		Total   int    `json:"total"`
		Results []struct {
			Name string `json:"name"`
			File string `json:"file"`
			Kind string `json:"kind"`
		} `json:"results"`
	}
	if err := json.Unmarshal([]byte(text.Text), &payload); err != nil {
		t.Fatalf("payload is not code.find JSON: %s", text.Text)
	}
	if payload.Mode != "keyword" {
		t.Fatalf("mode = %q, want keyword", payload.Mode)
	}
	if payload.Total != 1 || len(payload.Results) != 1 {
		t.Fatalf("results = %#v, total=%d; want one LSP-backed result", payload.Results, payload.Total)
	}
	if payload.Results[0].Name != "main" || payload.Results[0].File != "src/main.go" || payload.Results[0].Kind != "Function" {
		t.Fatalf("result = %#v, want Function main in src/main.go", payload.Results[0])
	}
}

func TestCodeFindReportsNoLSPSymbolsWhenSymbolsMissing(t *testing.T) {
	root := t.TempDir()
	srcDir := filepath.Join(root, "src")
	if err := os.MkdirAll(filepath.Join(root, ".knowns"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(srcDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(srcDir, "main.go"), []byte("package main\n\nfunc main() {}\n"), 0644); err != nil {
		t.Fatal(err)
	}
	store := storage.NewStore(filepath.Join(root, ".knowns"))
	runtime := &fakeCodeRuntime{session: fakeCodeSession{}}
	req := mcp.CallToolRequest{Params: mcp.CallToolParams{Arguments: map[string]any{
		"query": "main",
		"path":  "src",
		"limit": 5,
	}}}

	result, err := handleCodeFind(t.Context(), func() *storage.Store { return store }, func() CodeRuntime { return runtime }, req)
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
	var payload struct {
		Error               string `json:"error"`
		Mode                string `json:"mode"`
		Total               int    `json:"total"`
		FilesScanned        int    `json:"files_scanned"`
		FilesWithoutSymbols int    `json:"files_without_symbols"`
	}
	if err := json.Unmarshal([]byte(text.Text), &payload); err != nil {
		t.Fatalf("payload is not code.find error JSON: %s", text.Text)
	}
	if payload.Error != "no_lsp_symbols" {
		t.Fatalf("error = %q, want no_lsp_symbols", payload.Error)
	}
	if payload.Mode != "keyword" {
		t.Fatalf("mode = %q, want keyword", payload.Mode)
	}
	if payload.Total != 0 || payload.FilesScanned != 1 || payload.FilesWithoutSymbols != 1 {
		t.Fatalf("payload = %#v, want one scanned file without symbols", payload)
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
	result, err := handleCodeSymbols(t.Context(), func() *storage.Store { return store }, codeRuntimeFromLSPManagerProvider(func() *lsp.Manager { return mgr }), req)
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

type fakeCodeRuntime struct {
	session lsp.Session
	paths   []string
	err     error
}

func (r *fakeCodeRuntime) WithSession(ctx context.Context, path string, fn func(lsp.Session) error) error {
	r.paths = append(r.paths, path)
	if r.err != nil {
		return r.err
	}
	return fn(r.session)
}

func (r *fakeCodeRuntime) DescribeRuntimeError(string, error) *lsp.RuntimeError {
	return nil
}

type fakeCodeSession struct {
	symbols []lsp.DocumentSymbol
}

func (s fakeCodeSession) Start(context.Context) error { return nil }
func (s fakeCodeSession) Stop(context.Context) error  { return nil }
func (s fakeCodeSession) WaitReady(context.Context)   {}
func (s fakeCodeSession) Alive() bool                 { return true }
func (s fakeCodeSession) WithFile(_ context.Context, _ string, fn func() error) error {
	return fn()
}
func (s fakeCodeSession) DidChange(context.Context, string, string) error { return nil }
func (s fakeCodeSession) Definition(context.Context, string, int, int) (lsp.Location, error) {
	return lsp.Location{}, nil
}
func (s fakeCodeSession) References(context.Context, string, int, int) ([]lsp.Location, error) {
	return nil, nil
}
func (s fakeCodeSession) Implementations(context.Context, string, int, int) ([]lsp.Location, error) {
	return nil, nil
}
func (s fakeCodeSession) Diagnostics(context.Context, string) ([]lsp.Diagnostic, error) {
	return nil, nil
}
func (s fakeCodeSession) DocumentSymbols(context.Context, string) ([]lsp.DocumentSymbol, error) {
	return s.symbols, nil
}
func (s fakeCodeSession) WorkspaceSymbol(context.Context, string) ([]lsp.WorkspaceSymbolResult, error) {
	return nil, nil
}
func (s fakeCodeSession) Rename(context.Context, string, int, int, string) (*lsp.WorkspaceEdit, error) {
	return nil, nil
}
