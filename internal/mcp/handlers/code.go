package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/howznguyen/knowns/internal/lsp"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// RegisterCodeTool registers the consolidated code intelligence MCP tool.
func RegisterCodeTool(s *server.MCPServer, getStore func() *storage.Store, getLSPManager ...func() *lsp.Manager) {
	lspManager := func() *lsp.Manager { return nil }
	if len(getLSPManager) > 0 && getLSPManager[0] != nil {
		lspManager = getLSPManager[0]
	}
	s.AddTool(
		mcp.NewTool("code",
			mcp.WithDescription("Code intelligence operations. Use 'action' to specify: symbols, find, definition, references, implementations, diagnostics, rename, replace, replace_body, insert, delete."),
			mcp.WithString("action",
				mcp.Required(),
				mcp.Description("Action to perform"),
				mcp.Enum("symbols", "find", "definition", "references", "implementations", "diagnostics", "rename", "replace", "replace_body", "insert", "delete"),
			),
			mcp.WithString("query",
				mcp.Description("Search or symbol query (required for search, definition, references, implementations)"),
			),
			mcp.WithString("mode",
				mcp.Description("Search mode: hybrid, semantic, or keyword (default: hybrid)"),
				mcp.Enum("hybrid", "semantic", "keyword"),
			),
			mcp.WithNumber("limit",
				mcp.Description("Limit results (default: 10 for search, 100 for symbols, 200 for deps)"),
			),
			mcp.WithNumber("neighbors",
				mcp.Description("Max neighbors per match (default: 5) (search)"),
			),
			mcp.WithString("edgeTypes",
				mcp.Description("Optional comma-separated edge types to expand (search)"),
			),
			mcp.WithString("path",
				mcp.Description("File path filter or target file path (required for LSP actions)"),
			),
			mcp.WithString("kind",
				mcp.Description("Optional symbol kind filter (symbols)"),
			),
			mcp.WithString("type",
				mcp.Description("Optional edge type filter: calls, contains, has_method, imports, instantiates, implements, extends (deps)"),
			),
			mcp.WithString("severity",
				mcp.Description("Optional diagnostics severity filter: error, warning, info, hint"),
				mcp.Enum("error", "warning", "info", "hint"),
			),
		),
		func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			action, err := req.RequireString("action")
			if err != nil {
				return errResult("action is required")
			}
			switch action {
			case "symbols":
				return handleCodeSymbols(ctx, getStore, lspManager, req)
			case "search":
				return errResult("Action 'search' has been removed. Use LSP actions: symbols, definition, references, implementations, diagnostics.")
			case "deps":
				return errResult("Action 'deps' has been removed. Use LSP actions: symbols, definition, references, implementations, diagnostics.")
			case "graph":
				return errResult("Action 'graph' has been removed.")
			case "definition":
				return handleCodeDefinition(ctx, getStore, lspManager, req)
			case "references":
				return handleCodeReferences(ctx, getStore, lspManager, req)
			case "implementations":
				return handleCodeImplementations(ctx, getStore, lspManager, req)
			case "diagnostics":
				return handleCodeDiagnostics(ctx, getStore, lspManager, req)
			case "rename":
				return handleCodeRename(ctx, getStore, lspManager, req)
			case "replace":
				return handleCodeReplace(ctx, getStore, lspManager, req)
			case "replace_body":
				return handleCodeReplaceBody(ctx, getStore, lspManager, req)
			case "insert":
				return handleCodeInsert(ctx, getStore, lspManager, req)
			case "delete":
				return handleCodeDelete(ctx, getStore, lspManager, req)
			case "find":
				return handleCodeFind(ctx, getStore, lspManager, req)
			default:
				return errResultf("unsupported action: %s", action)
			}
		},
	)
}

func handleCodeDefinition(ctx context.Context, getStore func() *storage.Store, getLSPManager func() *lsp.Manager, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store, mgr, absPath, query, err := lspSymbolRequest(ctx, getStore, getLSPManager, req)
	if err != nil {
		return errResult(err.Error())
	}
	line, col, err := lsp.FindSymbolPosition(absPath, query)
	if err != nil {
		return errResult(err.Error())
	}
	var loc lsp.Location
	err = mgr.WithFile(ctx, absPath, func(srv *lsp.Server) error {
		var callErr error
		loc, callErr = srv.Definition(ctx, absPath, line, col)
		return callErr
	})
	if err != nil {
		return errResult(err.Error())
	}
	out, _ := json.MarshalIndent(locationResult(store.Root, loc), "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleCodeReferences(ctx context.Context, getStore func() *storage.Store, getLSPManager func() *lsp.Manager, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store, mgr, absPath, query, err := lspSymbolRequest(ctx, getStore, getLSPManager, req)
	if err != nil {
		return errResult(err.Error())
	}
	line, col, err := lsp.FindSymbolPosition(absPath, query)
	if err != nil {
		return errResult(err.Error())
	}
	var locs []lsp.Location
	err = mgr.WithFile(ctx, absPath, func(srv *lsp.Server) error {
		var callErr error
		locs, callErr = srv.References(ctx, absPath, line, col)
		return callErr
	})
	if err != nil {
		return errResult(err.Error())
	}
	items := make([]map[string]any, 0, len(locs))
	for _, loc := range locs {
		item := locationResult(store.Root, loc)
		if file, ok := item["file"].(string); ok {
			item["snippet"] = lsp.Snippet(filepath.Join(store.Root, file), loc.Range.Start.Line)
		}
		items = append(items, item)
	}
	out, _ := json.MarshalIndent(items, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleCodeImplementations(ctx context.Context, getStore func() *storage.Store, getLSPManager func() *lsp.Manager, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store, mgr, absPath, query, err := lspSymbolRequest(ctx, getStore, getLSPManager, req)
	if err != nil {
		return errResult(err.Error())
	}
	line, col, err := lsp.FindSymbolPosition(absPath, query)
	if err != nil {
		return errResult(err.Error())
	}
	var locs []lsp.Location
	err = mgr.WithFile(ctx, absPath, func(srv *lsp.Server) error {
		var callErr error
		locs, callErr = srv.Implementations(ctx, absPath, line, col)
		return callErr
	})
	if err != nil {
		return errResult(err.Error())
	}
	items := make([]map[string]any, 0, len(locs))
	for _, loc := range locs {
		item := locationResult(store.Root, loc)
		if file, ok := item["file"].(string); ok {
			item["name"] = lsp.NameAt(filepath.Join(store.Root, file), loc.Range.Start.Line, loc.Range.Start.Character)
		}
		items = append(items, item)
	}
	out, _ := json.MarshalIndent(items, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleCodeDiagnostics(ctx context.Context, getStore func() *storage.Store, getLSPManager func() *lsp.Manager, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store, mgr, absPath, err := lspPathRequest(ctx, getStore, getLSPManager, req)
	if err != nil {
		return errResult(err.Error())
	}
	args := req.GetArguments()
	severityFilter, _ := stringArg(args, "severity")
	var diagnostics []lsp.Diagnostic
	err = mgr.WithFile(ctx, absPath, func(srv *lsp.Server) error {
		var callErr error
		diagnostics, callErr = srv.Diagnostics(ctx, absPath)
		return callErr
	})
	if err != nil {
		return errResult(err.Error())
	}
	items := make([]map[string]any, 0, len(diagnostics))
	for _, diag := range diagnostics {
		severity := lspSeverity(diag.Severity)
		if severityFilter != "" && severityFilter != severity {
			continue
		}
		items = append(items, map[string]any{
			"file":     relPath(store.Root, absPath),
			"line":     diag.Range.Start.Line + 1,
			"column":   diag.Range.Start.Character + 1,
			"severity": severity,
			"message":  diag.Message,
		})
	}
	out, _ := json.MarshalIndent(items, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func lspSymbolRequest(ctx context.Context, getStore func() *storage.Store, getLSPManager func() *lsp.Manager, req mcp.CallToolRequest) (*storage.Store, *lsp.Manager, string, string, error) {
	store, mgr, absPath, err := lspPathRequest(ctx, getStore, getLSPManager, req)
	if err != nil {
		return nil, nil, "", "", err
	}
	query, err := req.RequireString("query")
	if err != nil || strings.TrimSpace(query) == "" {
		return nil, nil, "", "", fmt.Errorf("query is required")
	}
	return store, mgr, absPath, strings.TrimSpace(query), nil
}

func lspPathRequest(ctx context.Context, getStore func() *storage.Store, getLSPManager func() *lsp.Manager, req mcp.CallToolRequest) (*storage.Store, *lsp.Manager, string, error) {
	store := getStore()
	if store == nil {
		return nil, nil, "", fmt.Errorf("no project loaded")
	}
	if getLSPManager == nil {
		return nil, nil, "", fmt.Errorf("LSP not available for this project")
	}
	mgr := getLSPManager()
	if mgr == nil {
		return nil, nil, "", fmt.Errorf("LSP not available for this project")
	}
	path, err := req.RequireString("path")
	if err != nil || strings.TrimSpace(path) == "" {
		return nil, nil, "", fmt.Errorf("path is required")
	}
	absPath := path
	if !filepath.IsAbs(absPath) {
		absPath = filepath.Join(store.Root, absPath)
	}
	if srv, ok, err := mgr.ServerForPath(ctx, absPath); err != nil {
		return nil, nil, "", err
	} else if !ok || srv == nil {
		return nil, nil, "", fmt.Errorf("LSP not available for this language")
	}
	return store, mgr, absPath, nil
}

func locationResult(root string, loc lsp.Location) map[string]any {
	path := pathFromURI(loc.URI)
	return map[string]any{
		"file":   relPath(root, path),
		"line":   loc.Range.Start.Line + 1,
		"column": loc.Range.Start.Character + 1,
	}
}

func pathFromURI(uri string) string {
	return lsp.PathFromFileURI(uri)
}

func relPath(root, path string) string {
	if rel, err := filepath.Rel(root, path); err == nil && !strings.HasPrefix(rel, "..") {
		return filepath.ToSlash(rel)
	}
	return filepath.ToSlash(path)
}

func lspSeverity(severity int) string {
	switch severity {
	case 1:
		return "error"
	case 2:
		return "warning"
	case 3:
		return "info"
	case 4:
		return "hint"
	default:
		return "error"
	}
}

func handleCodeSymbols(ctx context.Context, getStore func() *storage.Store, getLSPManager func() *lsp.Manager, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store, mgr, absPath, err := lspPathRequest(ctx, getStore, getLSPManager, req)
	if err != nil {
		return errResult(err.Error())
	}
	_ = store
	var symbols []lsp.DocumentSymbol
	err = mgr.WithFile(ctx, absPath, func(srv *lsp.Server) error {
		var callErr error
		symbols, callErr = srv.DocumentSymbols(ctx, absPath)
		return callErr
	})
	if err != nil {
		return errResult(err.Error())
	}
	out, _ := json.MarshalIndent(symbols, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleCodeRename(ctx context.Context, getStore func() *storage.Store, getLSPManager func() *lsp.Manager, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store, mgr, absPath, err := lspPathRequest(ctx, getStore, getLSPManager, req)
	if err != nil {
		return errResult(err.Error())
	}
	args := req.GetArguments()
	line, ok := intArg(args, "line")
	if !ok {
		return errResult("line is required")
	}
	character, ok := intArg(args, "character")
	if !ok {
		return errResult("character is required")
	}
	newName, ok := stringArg(args, "newName")
	if !ok || strings.TrimSpace(newName) == "" {
		return errResult("newName is required")
	}
	var edit *lsp.WorkspaceEdit
	err = mgr.WithFile(ctx, absPath, func(srv *lsp.Server) error {
		var callErr error
		edit, callErr = srv.Rename(ctx, absPath, line, character, newName)
		return callErr
	})
	if err != nil {
		return errResult(err.Error())
	}
	changes := map[string][]lsp.TextEdit{}
	if edit != nil {
		changes = edit.AllChanges()
	}
	filesChanged, totalEdits, err := applyWorkspaceEdit(changes)
	if err != nil {
		return errResult(err.Error())
	}
	for i := range filesChanged {
		filesChanged[i] = relPath(store.Root, filesChanged[i])
	}
	out, _ := json.MarshalIndent(map[string]any{"success": true, "files_changed": filesChanged, "total_edits": totalEdits}, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleCodeReplace(ctx context.Context, getStore func() *storage.Store, getLSPManager func() *lsp.Manager, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return errResult("no project loaded")
	}
	args := req.GetArguments()
	path, ok := stringArg(args, "path")
	if !ok || strings.TrimSpace(path) == "" {
		return errResult("path is required")
	}
	needle, ok := textArg(args, "needle")
	if !ok || needle == "" {
		return errResult("needle is required")
	}
	repl, ok := textArg(args, "repl")
	if !ok {
		return errResult("repl is required")
	}
	mode, _ := stringArg(args, "mode")
	if mode == "" {
		mode = "literal"
	}
	allowMultiple := boolArg(args, "allow_multiple_occurrences")
	absPath := path
	if !filepath.IsAbs(absPath) {
		absPath = filepath.Join(store.Root, absPath)
	}
	data, err := os.ReadFile(absPath)
	if err != nil {
		return errResult(err.Error())
	}
	content := string(data)
	replacements := 0
	next := content
	switch mode {
	case "literal":
		replacements = strings.Count(content, needle)
		if replacements > 1 && !allowMultiple {
			return errResultf("multiple occurrences found (%d); set allow_multiple_occurrences=true", replacements)
		}
		next = strings.ReplaceAll(content, needle, repl)
	case "regex":
		re, err := regexp.Compile(needle)
		if err != nil {
			return errResult(err.Error())
		}
		replacements = len(re.FindAllStringIndex(content, -1))
		if replacements > 1 && !allowMultiple {
			return errResultf("multiple occurrences found (%d); set allow_multiple_occurrences=true", replacements)
		}
		next = re.ReplaceAllString(content, repl)
	default:
		return errResult("mode must be literal or regex")
	}
	if err := os.WriteFile(absPath, []byte(next), 0644); err != nil {
		return errResult(err.Error())
	}
	out, _ := json.MarshalIndent(map[string]any{"success": true, "path": relPath(store.Root, absPath), "replacements": replacements, "mode": mode}, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleCodeReplaceBody(ctx context.Context, getStore func() *storage.Store, getLSPManager func() *lsp.Manager, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store, mgr, absPath, err := lspPathRequest(ctx, getStore, getLSPManager, req)
	if err != nil {
		return errResult(err.Error())
	}
	args := req.GetArguments()
	name, ok := stringArg(args, "symbol")
	if !ok || strings.TrimSpace(name) == "" {
		return errResult("symbol is required")
	}
	body, ok := textArg(args, "body")
	if !ok {
		return errResult("body is required")
	}
	var sym lsp.DocumentSymbol
	var srvUsed *lsp.Server
	err = mgr.WithFile(ctx, absPath, func(srv *lsp.Server) error {
		symbols, e := srv.DocumentSymbols(ctx, absPath)
		if e != nil {
			return e
		}
		var found bool
		sym, found = findSymbolByName(symbols, name)
		if !found {
			return fmt.Errorf("symbol %q not found", name)
		}
		srvUsed = srv
		return nil
	})
	if err != nil {
		return errResult(err.Error())
	}
	linesReplaced, err := replaceLines(absPath, sym.Range.Start.Line, sym.Range.End.Line, body)
	if err != nil {
		return errResult(err.Error())
	}
	if err := notifyDidChange(ctx, srvUsed, absPath); err != nil {
		return errResult(err.Error())
	}
	out, _ := json.MarshalIndent(map[string]any{"success": true, "path": relPath(store.Root, absPath), "symbol": name, "lines_replaced": linesReplaced}, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleCodeInsert(ctx context.Context, getStore func() *storage.Store, getLSPManager func() *lsp.Manager, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store, mgr, absPath, err := lspPathRequest(ctx, getStore, getLSPManager, req)
	if err != nil {
		return errResult(err.Error())
	}
	args := req.GetArguments()
	name, ok := stringArg(args, "symbol")
	if !ok || strings.TrimSpace(name) == "" {
		return errResult("symbol is required")
	}
	position, _ := stringArg(args, "position")
	if position == "" {
		position = "after"
	}
	if position != "before" && position != "after" {
		return errResult("position must be before or after")
	}
	body, ok := textArg(args, "body")
	if !ok {
		return errResult("body is required")
	}
	var sym lsp.DocumentSymbol
	var srvUsed *lsp.Server
	err = mgr.WithFile(ctx, absPath, func(srv *lsp.Server) error {
		symbols, e := srv.DocumentSymbols(ctx, absPath)
		if e != nil {
			return e
		}
		var found bool
		sym, found = findSymbolByName(symbols, name)
		if !found {
			return fmt.Errorf("symbol %q not found", name)
		}
		srvUsed = srv
		return nil
	})
	if err != nil {
		return errResult(err.Error())
	}
	inserted, err := insertLines(absPath, sym, position, body)
	if err != nil {
		return errResult(err.Error())
	}
	if err := notifyDidChange(ctx, srvUsed, absPath); err != nil {
		return errResult(err.Error())
	}
	out, _ := json.MarshalIndent(map[string]any{"success": true, "path": relPath(store.Root, absPath), "position": position, "anchor": name, "lines_inserted": inserted}, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleCodeDelete(ctx context.Context, getStore func() *storage.Store, getLSPManager func() *lsp.Manager, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store, mgr, absPath, err := lspPathRequest(ctx, getStore, getLSPManager, req)
	if err != nil {
		return errResult(err.Error())
	}
	args := req.GetArguments()
	name, ok := stringArg(args, "symbol")
	if !ok || strings.TrimSpace(name) == "" {
		return errResult("symbol is required")
	}
	force := boolArg(args, "force")
	var sym lsp.DocumentSymbol
	var refs []lsp.Location
	var srvUsed *lsp.Server
	err = mgr.WithFile(ctx, absPath, func(srv *lsp.Server) error {
		symbols, e := srv.DocumentSymbols(ctx, absPath)
		if e != nil {
			return e
		}
		var found bool
		sym, found = findSymbolByName(symbols, name)
		if !found {
			return fmt.Errorf("symbol %q not found", name)
		}
		if !force {
			refs, e = srv.References(ctx, absPath, sym.SelectionRange.Start.Line, sym.SelectionRange.Start.Character)
			if e != nil {
				return e
			}
		}
		srvUsed = srv
		return nil
	})
	if err != nil {
		return errResult(err.Error())
	}
	if !force {
		external := externalReferences(store.Root, absPath, sym.Range, refs)
		if len(external) > 0 {
			out, _ := json.MarshalIndent(map[string]any{"error": "symbol has external references", "references": external}, "", "  ")
			return mcp.NewToolResultText(string(out)), nil
		}
	}
	deleted, err := replaceLines(absPath, sym.Range.Start.Line, sym.Range.End.Line, "")
	if err != nil {
		return errResult(err.Error())
	}
	if err := notifyDidChange(ctx, srvUsed, absPath); err != nil {
		return errResult(err.Error())
	}
	out, _ := json.MarshalIndent(map[string]any{"success": true, "path": relPath(store.Root, absPath), "symbol": name, "lines_deleted": deleted}, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleCodeFind(ctx context.Context, getStore func() *storage.Store, getLSPManager func() *lsp.Manager, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return errResult("no project loaded")
	}
	mgr := getLSPManager()
	if mgr == nil {
		return errResult("LSP not available for this project")
	}
	args := req.GetArguments()
	query, ok := stringArg(args, "query")
	if !ok || strings.TrimSpace(query) == "" {
		return errResult("query is required")
	}
	path, _ := stringArg(args, "path")
	includeBody := boolArg(args, "include_body")
	depth, _ := intArg(args, "depth")
	limit, ok := intArg(args, "limit")
	if !ok || limit <= 0 {
		limit = 20
	}
	files, err := findCodeFiles(store.Root, path)
	if err != nil {
		return errResult(err.Error())
	}
	results := []map[string]any{}
	for _, file := range files {
		if len(results) >= limit {
			break
		}
		_ = mgr.WithFile(ctx, file, func(srv *lsp.Server) error {
			symbols, e := srv.DocumentSymbols(ctx, file)
			if e != nil {
				return nil
			}
			appendSymbolMatches(&results, store.Root, file, symbols, query, includeBody, depth, limit)
			return nil
		})
	}
	out, _ := json.MarshalIndent(map[string]any{"results": results, "total": len(results)}, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func applyWorkspaceEdit(changes map[string][]lsp.TextEdit) ([]string, int, error) {
	originals := map[string][]byte{}
	updated := map[string][]byte{}
	files := make([]string, 0, len(changes))
	total := 0
	for uri, edits := range changes {
		if len(edits) == 0 {
			continue
		}
		path := pathFromURI(uri)
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, 0, err
		}
		originals[path] = data
		next, err := applyTextEdits(string(data), edits)
		if err != nil {
			return nil, 0, err
		}
		updated[path] = []byte(next)
		files = append(files, path)
		total += len(edits)
	}
	for _, path := range files {
		if err := os.WriteFile(path, updated[path], 0644); err != nil {
			for rollbackPath, data := range originals {
				_ = os.WriteFile(rollbackPath, data, 0644)
			}
			return nil, 0, err
		}
	}
	sort.Strings(files)
	return files, total, nil
}

func applyTextEdits(content string, edits []lsp.TextEdit) (string, error) {
	sorted := append([]lsp.TextEdit(nil), edits...)
	sort.SliceStable(sorted, func(i, j int) bool {
		a, b := sorted[i].Range.Start, sorted[j].Range.Start
		if a.Line != b.Line {
			return a.Line > b.Line
		}
		return a.Character > b.Character
	})
	out := content
	for _, edit := range sorted {
		start, err := offsetForPosition(out, edit.Range.Start)
		if err != nil {
			return "", err
		}
		end, err := offsetForPosition(out, edit.Range.End)
		if err != nil {
			return "", err
		}
		if start > end {
			return "", fmt.Errorf("invalid edit range")
		}
		out = out[:start] + edit.NewText + out[end:]
	}
	return out, nil
}

func offsetForPosition(content string, pos lsp.Position) (int, error) {
	if pos.Line < 0 || pos.Character < 0 {
		return 0, fmt.Errorf("invalid position")
	}
	lines := strings.SplitAfter(content, "\n")
	if pos.Line >= len(lines) {
		if pos.Line == len(lines) && pos.Character == 0 {
			return len(content), nil
		}
		return 0, fmt.Errorf("line %d out of range", pos.Line)
	}
	offset := 0
	for i := 0; i < pos.Line; i++ {
		offset += len(lines[i])
	}
	line := strings.TrimSuffix(lines[pos.Line], "\n")
	col, err := utf16OffsetToByteOffset(line, pos.Character)
	if err != nil {
		return 0, err
	}
	return offset + col, nil
}

func utf16OffsetToByteOffset(s string, target int) (int, error) {
	units := 0
	for i, r := range s {
		if units == target {
			return i, nil
		}
		if r > 0xffff {
			units += 2
		} else {
			units++
		}
		if units > target {
			return 0, fmt.Errorf("character %d splits utf16 surrogate", target)
		}
	}
	if units == target {
		return len(s), nil
	}
	return 0, fmt.Errorf("character %d out of range", target)
}

func findSymbolByName(symbols []lsp.DocumentSymbol, name string) (lsp.DocumentSymbol, bool) {
	parts := strings.Split(strings.TrimSpace(name), ".")
	return findSymbolByParts(symbols, parts)
}

func findSymbolByParts(symbols []lsp.DocumentSymbol, parts []string) (lsp.DocumentSymbol, bool) {
	if len(parts) == 0 || parts[0] == "" {
		return lsp.DocumentSymbol{}, false
	}
	for _, sym := range symbols {
		if sym.Name == parts[0] {
			if len(parts) == 1 {
				return sym, true
			}
			return findSymbolByParts(sym.Children, parts[1:])
		}
		if found, ok := findSymbolByParts(sym.Children, parts); ok {
			return found, true
		}
	}
	return lsp.DocumentSymbol{}, false
}

func replaceLines(path string, start, end int, body string) (int, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	lines := strings.Split(string(data), "\n")
	if start < 0 || end < start || start >= len(lines) {
		return 0, fmt.Errorf("invalid symbol range")
	}
	if end >= len(lines) {
		end = len(lines) - 1
	}
	replacement := []string{}
	if body != "" {
		replacement = strings.Split(strings.TrimRight(body, "\n"), "\n")
	}
	next := append([]string{}, lines[:start]...)
	next = append(next, replacement...)
	next = append(next, lines[end+1:]...)
	return end - start + 1, os.WriteFile(path, []byte(strings.Join(next, "\n")), 0644)
}

func insertLines(path string, sym lsp.DocumentSymbol, position, body string) (int, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	lines := strings.Split(string(data), "\n")
	insert := strings.Split(strings.TrimRight(body, "\n"), "\n")
	idx := sym.Range.End.Line + 1
	if position == "before" {
		idx = sym.Range.Start.Line
	}
	if idx < 0 || idx > len(lines) {
		return 0, fmt.Errorf("invalid symbol range")
	}
	next := append([]string{}, lines[:idx]...)
	next = append(next, insert...)
	next = append(next, lines[idx:]...)
	return len(insert), os.WriteFile(path, []byte(strings.Join(next, "\n")), 0644)
}

func notifyDidChange(ctx context.Context, srv *lsp.Server, path string) error {
	if srv == nil {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return srv.DidChange(ctx, path, string(data))
}

func externalReferences(root, selfPath string, rng lsp.Range, refs []lsp.Location) []map[string]any {
	out := []map[string]any{}
	for _, ref := range refs {
		path := pathFromURI(ref.URI)
		pos := ref.Range.Start
		if path == selfPath && positionInRange(pos, rng) {
			continue
		}
		out = append(out, locationResult(root, ref))
	}
	return out
}

func positionInRange(pos lsp.Position, rng lsp.Range) bool {
	if pos.Line < rng.Start.Line || pos.Line > rng.End.Line {
		return false
	}
	if pos.Line == rng.Start.Line && pos.Character < rng.Start.Character {
		return false
	}
	if pos.Line == rng.End.Line && pos.Character > rng.End.Character {
		return false
	}
	return true
}

func findCodeFiles(root, path string) ([]string, error) {
	base := root
	if strings.TrimSpace(path) != "" {
		base = path
		if !filepath.IsAbs(base) {
			base = filepath.Join(root, base)
		}
	}
	info, err := os.Stat(base)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return []string{base}, nil
	}
	files := []string{}
	err = filepath.WalkDir(base, func(p string, d os.DirEntry, err error) error {
		if err != nil || len(files) >= 50 {
			return err
		}
		if d.IsDir() {
			name := d.Name()
			if strings.HasPrefix(name, ".") || name == "node_modules" || name == "vendor" || name == "dist" || name == "build" {
				if p != base {
					return filepath.SkipDir
				}
			}
			return nil
		}
		if isSourceFile(p) {
			files = append(files, p)
		}
		return nil
	})
	return files, err
}

func appendSymbolMatches(results *[]map[string]any, root, file string, symbols []lsp.DocumentSymbol, query string, includeBody bool, depth, limit int) {
	for _, sym := range symbols {
		if len(*results) >= limit {
			return
		}
		appendOneSymbolMatch(results, root, file, sym, "", query, includeBody, depth)
		appendSymbolMatches(results, root, file, sym.Children, query, includeBody, depth, limit)
	}
}

func appendOneSymbolMatch(results *[]map[string]any, root, file string, sym lsp.DocumentSymbol, parent, query string, includeBody bool, depth int) {
	full := sym.Name
	if parent != "" {
		full = parent + "." + sym.Name
	}
	matched := strings.Contains(strings.ToLower(sym.Name), strings.ToLower(query)) || strings.Contains(strings.ToLower(full), strings.ToLower(query))
	if !matched {
		for _, child := range sym.Children {
			appendOneSymbolMatch(results, root, file, child, full, query, includeBody, depth)
		}
		return
	}
	item := map[string]any{"name": sym.Name, "full_name": full, "file": relPath(root, file), "line": sym.Range.Start.Line + 1, "column": sym.Range.Start.Character + 1, "kind": sym.Kind}
	if includeBody {
		item["body"] = sourceForRange(file, sym.Range)
	}
	if depth > 0 && len(sym.Children) > 0 {
		item["children"] = symbolChildren(sym.Children, depth-1)
	}
	*results = append(*results, item)
}

func symbolChildren(symbols []lsp.DocumentSymbol, depth int) []map[string]any {
	children := make([]map[string]any, 0, len(symbols))
	for _, sym := range symbols {
		item := map[string]any{"name": sym.Name, "line": sym.Range.Start.Line + 1, "column": sym.Range.Start.Character + 1, "kind": sym.Kind}
		if depth > 0 && len(sym.Children) > 0 {
			item["children"] = symbolChildren(sym.Children, depth-1)
		}
		children = append(children, item)
	}
	return children
}

func sourceForRange(path string, rng lsp.Range) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	lines := strings.Split(string(data), "\n")
	if rng.Start.Line < 0 || rng.Start.Line >= len(lines) {
		return ""
	}
	end := rng.End.Line
	if end >= len(lines) {
		end = len(lines) - 1
	}
	return strings.Join(lines[rng.Start.Line:end+1], "\n")
}

func isSourceFile(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".go", ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".java", ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".rb", ".php", ".swift", ".kt", ".kts":
		return true
	default:
		return false
	}
}
