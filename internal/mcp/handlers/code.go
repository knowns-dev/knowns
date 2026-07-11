package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/howznguyen/knowns/internal/lsp"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// projectRoot returns the project root directory (parent of .knowns/).
func projectRoot(store *storage.Store) string {
	return filepath.Dir(store.Root)
}

// RegisterCodeTool registers the consolidated code intelligence MCP tool.
func RegisterCodeTool(s *server.MCPServer, getStore func() *storage.Store, getLSPManager ...func() *lsp.Manager) {
	lspManager := func() *lsp.Manager { return nil }
	if len(getLSPManager) > 0 && getLSPManager[0] != nil {
		lspManager = getLSPManager[0]
	}
	RegisterCodeToolWithRuntime(s, getStore, codeRuntimeFromLSPManagerProvider(lspManager))
}

// RegisterCodeToolWithRuntime registers code tools against an abstract runtime.
func RegisterCodeToolWithRuntime(s *server.MCPServer, getStore func() *storage.Store, getCodeRuntime func() CodeRuntime) {
	if getCodeRuntime == nil {
		getCodeRuntime = func() CodeRuntime { return nil }
	}
	s.AddTool(
		mcp.NewTool("code",
			mcp.WithDescription("Code intelligence operations. Use 'action' to specify: symbols, find, definition, references, implementations, diagnostics, rename, replace, replace_body, insert, delete. Symbols and find return compact JSON by default; set verbose=true for raw/full LSP-style output."),
			mcp.WithString("action",
				mcp.Required(),
				mcp.Description("Action to perform"),
				mcp.Enum("symbols", "find", "definition", "references", "implementations", "diagnostics", "rename", "replace", "replace_body", "insert", "delete"),
			),
			mcp.WithString("query",
				mcp.Description("Search or symbol query (required for search, definition, references, implementations)"),
			),
			mcp.WithString("mode",
				mcp.Description("Mode: find uses hybrid/semantic/keyword; replace uses literal/regex"),
				mcp.Enum("hybrid", "semantic", "keyword", "literal", "regex"),
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
			mcp.WithString("verbose",
				mcp.Description("When true, return full LSP-style output instead of compact format. Supported by: symbols, find."),
			),
			mcp.WithString("symbol",
				mcp.Description("Symbol name for rename, replace_body, insert, or delete. Nested names may use dots like Type.Method."),
			),
			mcp.WithString("needle",
				mcp.Description("Text or regex pattern to replace for action=replace."),
			),
			mcp.WithString("repl",
				mcp.Description("Replacement text for action=replace."),
			),
			mcp.WithBoolean("allow_multiple_occurrences",
				mcp.Description("For action=replace, allow replacing multiple matches. Defaults to false."),
			),
			mcp.WithString("body",
				mcp.Description("Replacement or inserted source for replace_body or insert."),
			),
			mcp.WithString("position",
				mcp.Description("For action=insert, insertion position: before or after."),
				mcp.Enum("before", "after"),
			),
		),
		func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			action, err := req.RequireString("action")
			if err != nil {
				return errResult("action is required")
			}
			switch action {
			case "symbols":
				return handleCodeSymbols(ctx, getStore, getCodeRuntime, req)
			case "search":
				return errResult("Action 'search' has been removed. Use LSP actions: symbols, definition, references, implementations, diagnostics.")
			case "deps":
				return errResult("Action 'deps' has been removed. Use LSP actions: symbols, definition, references, implementations, diagnostics.")
			case "graph":
				return errResult("Action 'graph' has been removed.")
			case "definition":
				return handleCodeDefinition(ctx, getStore, getCodeRuntime, req)
			case "references":
				return handleCodeReferences(ctx, getStore, getCodeRuntime, req)
			case "implementations":
				return handleCodeImplementations(ctx, getStore, getCodeRuntime, req)
			case "diagnostics":
				return handleCodeDiagnostics(ctx, getStore, getCodeRuntime, req)
			case "rename":
				return handleCodeRename(ctx, getStore, getCodeRuntime, req)
			case "replace":
				return handleCodeReplace(ctx, getStore, getCodeRuntime, req)
			case "replace_body":
				return handleCodeReplaceBody(ctx, getStore, getCodeRuntime, req)
			case "insert":
				return handleCodeInsert(ctx, getStore, getCodeRuntime, req)
			case "delete":
				return handleCodeDelete(ctx, getStore, getCodeRuntime, req)
			case "find":
				return handleCodeFind(ctx, getStore, getCodeRuntime, req)
			default:
				return errResultf("unsupported action: %s", action)
			}
		},
	)
}

func handleCodeDefinition(ctx context.Context, getStore func() *storage.Store, getCodeRuntime func() CodeRuntime, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store, mgr, absPath, query, err := lspSymbolRequest(ctx, getStore, getCodeRuntime, req)
	if err != nil {
		return errResult(err.Error())
	}
	line, col, err := lsp.FindSymbolPosition(absPath, query)
	if err != nil {
		return errResult(err.Error())
	}
	var loc lsp.Location
	err = mgr.WithSession(ctx, absPath, func(session lsp.Session) error {
		var callErr error
		loc, callErr = session.Definition(ctx, absPath, line, col)
		return callErr
	})
	if err != nil {
		return errResult(err.Error())
	}
	out, _ := json.MarshalIndent(locationResult(projectRoot(store), loc), "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleCodeReferences(ctx context.Context, getStore func() *storage.Store, getCodeRuntime func() CodeRuntime, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store, mgr, absPath, query, err := lspSymbolRequest(ctx, getStore, getCodeRuntime, req)
	if err != nil {
		return errResult(err.Error())
	}
	line, col, err := lsp.FindSymbolPosition(absPath, query)
	if err != nil {
		return errResult(err.Error())
	}
	var locs []lsp.Location
	err = mgr.WithSession(ctx, absPath, func(session lsp.Session) error {
		var callErr error
		locs, callErr = session.References(ctx, absPath, line, col)
		return callErr
	})
	if err != nil {
		return errResult(err.Error())
	}
	items := make([]map[string]any, 0, len(locs))
	for _, loc := range locs {
		item := locationResult(projectRoot(store), loc)
		if file, ok := item["file"].(string); ok {
			item["snippet"] = lsp.Snippet(filepath.Join(projectRoot(store), file), loc.Range.Start.Line)
		}
		items = append(items, item)
	}
	out, _ := json.MarshalIndent(items, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleCodeImplementations(ctx context.Context, getStore func() *storage.Store, getCodeRuntime func() CodeRuntime, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store, mgr, absPath, query, err := lspSymbolRequest(ctx, getStore, getCodeRuntime, req)
	if err != nil {
		return errResult(err.Error())
	}
	line, col, err := lsp.FindSymbolPosition(absPath, query)
	if err != nil {
		return errResult(err.Error())
	}
	var locs []lsp.Location
	err = mgr.WithSession(ctx, absPath, func(session lsp.Session) error {
		var callErr error
		locs, callErr = session.Implementations(ctx, absPath, line, col)
		return callErr
	})
	if err != nil {
		return errResult(err.Error())
	}
	items := make([]map[string]any, 0, len(locs))
	for _, loc := range locs {
		item := locationResult(projectRoot(store), loc)
		if file, ok := item["file"].(string); ok {
			item["name"] = lsp.NameAt(filepath.Join(projectRoot(store), file), loc.Range.Start.Line, loc.Range.Start.Character)
		}
		items = append(items, item)
	}
	out, _ := json.MarshalIndent(items, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleCodeDiagnostics(ctx context.Context, getStore func() *storage.Store, getCodeRuntime func() CodeRuntime, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store, mgr, absPath, err := lspPathRequest(ctx, getStore, getCodeRuntime, req)
	if err != nil {
		return errResult(err.Error())
	}
	args := req.GetArguments()
	severityFilter, _ := stringArg(args, "severity")
	var diagnostics []lsp.Diagnostic
	err = mgr.WithSession(ctx, absPath, func(session lsp.Session) error {
		var callErr error
		diagnostics, callErr = session.Diagnostics(ctx, absPath)
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
			"file":     relPath(projectRoot(store), absPath),
			"line":     diag.Range.Start.Line + 1,
			"column":   diag.Range.Start.Character + 1,
			"severity": severity,
			"message":  diag.Message,
		})
	}
	out, _ := json.MarshalIndent(items, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func lspSymbolRequest(ctx context.Context, getStore func() *storage.Store, getCodeRuntime func() CodeRuntime, req mcp.CallToolRequest) (*storage.Store, CodeRuntime, string, string, error) {
	store, mgr, absPath, err := lspPathRequest(ctx, getStore, getCodeRuntime, req)
	if err != nil {
		return nil, nil, "", "", err
	}
	query, err := req.RequireString("query")
	if err != nil || strings.TrimSpace(query) == "" {
		return nil, nil, "", "", fmt.Errorf("query is required")
	}
	return store, mgr, absPath, strings.TrimSpace(query), nil
}

func lspPathRequest(ctx context.Context, getStore func() *storage.Store, getCodeRuntime func() CodeRuntime, req mcp.CallToolRequest) (*storage.Store, CodeRuntime, string, error) {
	store := getStore()
	if store == nil {
		return nil, nil, "", fmt.Errorf("no project loaded")
	}
	path, err := req.RequireString("path")
	if err != nil || strings.TrimSpace(path) == "" {
		return nil, nil, "", fmt.Errorf("path is required")
	}
	absPath := path
	if !filepath.IsAbs(absPath) {
		absPath = filepath.Join(projectRoot(store), absPath)
	}
	if getCodeRuntime == nil {
		return nil, nil, "", fmt.Errorf("LSP not available for this project")
	}
	mgr := getCodeRuntime()
	if mgr == nil {
		return nil, nil, "", fmt.Errorf("LSP not available for this project")
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

// symbolKindString converts LSP SymbolKind numeric code to human-readable string.
func symbolKindString(kind int) string {
	switch kind {
	case 1:
		return "File"
	case 2:
		return "Module"
	case 3:
		return "Namespace"
	case 4:
		return "Package"
	case 5:
		return "Class"
	case 6:
		return "Method"
	case 7:
		return "Property"
	case 8:
		return "Field"
	case 9:
		return "Constructor"
	case 10:
		return "Enum"
	case 11:
		return "Interface"
	case 12:
		return "Function"
	case 13:
		return "Variable"
	case 14:
		return "Constant"
	case 15:
		return "String"
	case 16:
		return "Number"
	case 17:
		return "Boolean"
	case 18:
		return "Array"
	case 19:
		return "Object"
	case 20:
		return "Key"
	case 21:
		return "Null"
	case 22:
		return "EnumMember"
	case 23:
		return "Struct"
	case 24:
		return "Event"
	case 25:
		return "Operator"
	case 26:
		return "TypeParameter"
	default:
		return "Unknown"
	}
}

func handleCodeSymbols(ctx context.Context, getStore func() *storage.Store, getCodeRuntime func() CodeRuntime, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store, mgr, absPath, err := lspPathRequest(ctx, getStore, getCodeRuntime, req)
	if err != nil {
		if result, ok := lspRuntimeErrResult(err); ok {
			return result, nil
		}
		return errResult(err.Error())
	}
	args := req.GetArguments()
	depth, _ := intArg(args, "depth")
	includeBody := boolArg(args, "include_body")
	verbose := boolArg(args, "verbose")
	kindFilter, _ := stringArg(args, "kind")

	var symbols []lsp.DocumentSymbol
	err = mgr.WithSession(ctx, absPath, func(session lsp.Session) error {
		var callErr error
		symbols, callErr = session.DocumentSymbols(ctx, absPath)
		return callErr
	})
	if err != nil {
		if runtimeErr := mgr.DescribeRuntimeError(absPath, err); runtimeErr != nil {
			return lspRuntimeErrPayloadResult(runtimeErr), nil
		}
		if result, ok := lspRuntimeErrResult(err); ok {
			return result, nil
		}
		return errResult(err.Error())
	}
	if kindFilter != "" {
		symbols = filterSymbolsByKind(symbols, kindFilter)
	}
	if verbose {
		out, _ := json.MarshalIndent(symbols, "", "  ")
		return mcp.NewToolResultText(string(out)), nil
	}
	var resp any
	if includeBody {
		resp = detailedSymbols(projectRoot(store), absPath, symbols)
	} else if depth > 0 {
		resp = nestedSymbols(symbols, depth)
	} else {
		resp = groupedSymbolNames(symbols)
	}
	out, _ := json.MarshalIndent(resp, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func lspRuntimeErrResult(err error) (*mcp.CallToolResult, bool) {
	var runtimeErr *lsp.RuntimeError
	if errors.As(err, &runtimeErr) {
		return lspRuntimeErrPayloadResult(runtimeErr), true
	}
	return nil, false
}

func lspRuntimeErrPayloadResult(runtimeErr *lsp.RuntimeError) *mcp.CallToolResult {
	out, _ := json.MarshalIndent(runtimeErr.Payload(), "", "  ")
	return mcp.NewToolResultError(string(out))
}

// groupedSymbolNames produces {kind: [name1, name2, ...]} — compact default.
func groupedSymbolNames(symbols []lsp.DocumentSymbol) map[string][]string {
	grouped := make(map[string][]string)
	for _, sym := range symbols {
		groupSymbolNames(grouped, "", sym)
	}
	return grouped
}

func groupSymbolNames(grouped map[string][]string, parent string, sym lsp.DocumentSymbol) {
	name := sym.Name
	if parent != "" {
		name = parent + "." + sym.Name
	}
	kind := symbolKindString(sym.Kind)
	grouped[kind] = append(grouped[kind], name)
	for _, child := range sym.Children {
		groupSymbolNames(grouped, name, child)
	}
}

// nestedSymbols returns symbols with children up to given depth, flat kind strings.
func nestedSymbols(symbols []lsp.DocumentSymbol, depth int) []map[string]any {
	result := make([]map[string]any, 0, len(symbols))
	for _, sym := range symbols {
		item := map[string]any{
			"name": sym.Name,
			"kind": symbolKindString(sym.Kind),
			"line": sym.Range.Start.Line + 1,
		}
		if depth > 0 && len(sym.Children) > 0 {
			item["children"] = nestedSymbols(sym.Children, depth-1)
		}
		result = append(result, item)
	}
	return result
}

// detailedSymbols returns per-symbol detail with compact location and body source.
func detailedSymbols(root, absPath string, symbols []lsp.DocumentSymbol) []map[string]any {
	result := make([]map[string]any, 0, len(symbols))
	for _, sym := range symbols {
		item := detailedSymbol(root, absPath, sym)
		result = append(result, item)
	}
	return result
}

func detailedSymbol(root, absPath string, sym lsp.DocumentSymbol) map[string]any {
	item := map[string]any{
		"name": sym.Name,
		"kind": symbolKindString(sym.Kind),
		"file": relPath(root, absPath),
		"body_location": map[string]int{
			"start_line": sym.Range.Start.Line + 1,
			"end_line":   sym.Range.End.Line + 1,
		},
		"body": sourceForRange(absPath, sym.Range),
	}
	if len(sym.Children) > 0 {
		children := make([]map[string]any, 0, len(sym.Children))
		for _, child := range sym.Children {
			children = append(children, detailedSymbol(root, absPath, child))
		}
		item["children"] = children
	}
	return item
}

// filterSymbolsByKind returns symbols matching a kind string filter.
func filterSymbolsByKind(symbols []lsp.DocumentSymbol, kind string) []lsp.DocumentSymbol {
	out := make([]lsp.DocumentSymbol, 0)
	for _, sym := range symbols {
		if strings.EqualFold(symbolKindString(sym.Kind), kind) {
			out = append(out, sym)
		}
	}
	return out
}

func handleCodeRename(ctx context.Context, getStore func() *storage.Store, getCodeRuntime func() CodeRuntime, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store, mgr, absPath, err := lspPathRequest(ctx, getStore, getCodeRuntime, req)
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
	err = mgr.WithSession(ctx, absPath, func(session lsp.Session) error {
		var callErr error
		edit, callErr = session.Rename(ctx, absPath, line, character, newName)
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
		filesChanged[i] = relPath(projectRoot(store), filesChanged[i])
	}
	out, _ := json.MarshalIndent(map[string]any{"success": true, "files_changed": filesChanged, "total_edits": totalEdits}, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleCodeReplace(ctx context.Context, getStore func() *storage.Store, getCodeRuntime func() CodeRuntime, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
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
		absPath = filepath.Join(projectRoot(store), absPath)
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
	out, _ := json.MarshalIndent(map[string]any{"success": true, "path": relPath(projectRoot(store), absPath), "replacements": replacements, "mode": mode}, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleCodeReplaceBody(ctx context.Context, getStore func() *storage.Store, getCodeRuntime func() CodeRuntime, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store, mgr, absPath, err := lspPathRequest(ctx, getStore, getCodeRuntime, req)
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
	var sessionUsed lsp.Session
	err = mgr.WithSession(ctx, absPath, func(session lsp.Session) error {
		symbols, e := session.DocumentSymbols(ctx, absPath)
		if e != nil {
			return e
		}
		var found bool
		sym, found, e = findSymbolByName(symbols, name)
		if e != nil {
			return e
		}
		if !found {
			return fmt.Errorf("symbol %q not found", name)
		}
		sessionUsed = session
		return nil
	})
	if err != nil {
		return errResult(err.Error())
	}
	linesReplaced, err := replaceLines(absPath, sym.Range.Start.Line, sym.Range.End.Line, body)
	if err != nil {
		return errResult(err.Error())
	}
	if err := notifyDidChange(ctx, sessionUsed, absPath); err != nil {
		return errResult(err.Error())
	}
	out, _ := json.MarshalIndent(map[string]any{"success": true, "path": relPath(projectRoot(store), absPath), "symbol": name, "lines_replaced": linesReplaced}, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleCodeInsert(ctx context.Context, getStore func() *storage.Store, getCodeRuntime func() CodeRuntime, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store, mgr, absPath, err := lspPathRequest(ctx, getStore, getCodeRuntime, req)
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
	var sessionUsed lsp.Session
	err = mgr.WithSession(ctx, absPath, func(session lsp.Session) error {
		symbols, e := session.DocumentSymbols(ctx, absPath)
		if e != nil {
			return e
		}
		var found bool
		sym, found, e = findSymbolByName(symbols, name)
		if e != nil {
			return e
		}
		if !found {
			return fmt.Errorf("symbol %q not found", name)
		}
		sessionUsed = session
		return nil
	})
	if err != nil {
		return errResult(err.Error())
	}
	inserted, err := insertLines(absPath, sym, position, body)
	if err != nil {
		return errResult(err.Error())
	}
	if err := notifyDidChange(ctx, sessionUsed, absPath); err != nil {
		return errResult(err.Error())
	}
	out, _ := json.MarshalIndent(map[string]any{"success": true, "path": relPath(projectRoot(store), absPath), "position": position, "anchor": name, "lines_inserted": inserted}, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleCodeDelete(ctx context.Context, getStore func() *storage.Store, getCodeRuntime func() CodeRuntime, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store, mgr, absPath, err := lspPathRequest(ctx, getStore, getCodeRuntime, req)
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
	var sessionUsed lsp.Session
	err = mgr.WithSession(ctx, absPath, func(session lsp.Session) error {
		symbols, e := session.DocumentSymbols(ctx, absPath)
		if e != nil {
			return e
		}
		var found bool
		sym, found, e = findSymbolByName(symbols, name)
		if e != nil {
			return e
		}
		if !found {
			return fmt.Errorf("symbol %q not found", name)
		}
		if !force {
			refs, e = session.References(ctx, absPath, sym.SelectionRange.Start.Line, sym.SelectionRange.Start.Character)
			if e != nil {
				return e
			}
		}
		sessionUsed = session
		return nil
	})
	if err != nil {
		return errResult(err.Error())
	}
	if !force {
		external := externalReferences(projectRoot(store), absPath, sym.Range, refs)
		if len(external) > 0 {
			out, _ := json.MarshalIndent(map[string]any{"error": "symbol has external references", "references": external}, "", "  ")
			return mcp.NewToolResultText(string(out)), nil
		}
	}
	deleted, err := replaceLines(absPath, sym.Range.Start.Line, sym.Range.End.Line, "")
	if err != nil {
		return errResult(err.Error())
	}
	if err := notifyDidChange(ctx, sessionUsed, absPath); err != nil {
		return errResult(err.Error())
	}
	out, _ := json.MarshalIndent(map[string]any{"success": true, "path": relPath(projectRoot(store), absPath), "symbol": name, "lines_deleted": deleted}, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleCodeFind(ctx context.Context, getStore func() *storage.Store, getCodeRuntime func() CodeRuntime, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return errResult("no project loaded")
	}
	args := req.GetArguments()
	query, ok := stringArg(args, "query")
	if !ok || strings.TrimSpace(query) == "" {
		return errResult("query is required")
	}
	if getCodeRuntime == nil {
		return errResult("LSP not available for this project")
	}
	mgr := getCodeRuntime()
	if mgr == nil {
		return errResult("LSP not available for this project")
	}
	path, _ := stringArg(args, "path")
	includeBody := boolArg(args, "include_body")
	verbose := boolArg(args, "verbose")
	publicMode := "keyword"
	limit, ok := intArg(args, "limit")
	if !ok || limit <= 0 {
		limit = 20
	}

	root := projectRoot(store)
	var summaries []search.CodeSummary

	files, err := findCodeFiles(root, path)
	if err != nil {
		return errResult(err.Error())
	}
	if len(files) == 0 {
		out, _ := json.MarshalIndent(map[string]any{
			"error":         "no_code_files",
			"message":       "keyword code search requires LSP DocumentSymbols, but no source files matched the requested path",
			"mode":          publicMode,
			"results":       []map[string]any{},
			"total":         0,
			"files_scanned": 0,
		}, "", "  ")
		return mcp.NewToolResultError(string(out)), nil
	}
	type failedFile struct {
		File  string `json:"file"`
		Error string `json:"error"`
	}
	failedFiles := make([]failedFile, 0)
	filesWithoutSymbols := 0
	for _, file := range files {
		fileSummaries, err := buildFileSummaries(ctx, mgr, root, file)
		if err != nil {
			if len(failedFiles) < 5 {
				failedFiles = append(failedFiles, failedFile{
					File:  relPath(root, file),
					Error: err.Error(),
				})
			}
			filesWithoutSymbols++
			continue
		}
		if len(fileSummaries) == 0 {
			filesWithoutSymbols++
			continue
		}
		summaries = append(summaries, fileSummaries...)
		if len(summaries) > 5000 {
			break
		}
	}
	if len(summaries) == 0 {
		errCode := "no_lsp_symbols"
		message := "keyword code search requires LSP DocumentSymbols, but LSP returned no symbols for the scanned files"
		if len(failedFiles) > 0 && filesWithoutSymbols == len(files) {
			errCode = "lsp_symbols_unavailable"
			message = "keyword code search requires LSP DocumentSymbols, but LSP symbol requests failed or returned no symbols for all scanned files"
		}
		out, _ := json.MarshalIndent(map[string]any{
			"error":                 errCode,
			"message":               message,
			"mode":                  publicMode,
			"results":               []map[string]any{},
			"total":                 0,
			"files_scanned":         len(files),
			"files_without_symbols": filesWithoutSymbols,
			"failed_files":          failedFiles,
		}, "", "  ")
		return mcp.NewToolResultError(string(out)), nil
	}

	scorer := search.NewCodeBM25Scorer(summaries)
	bm25Results, err := scorer.Search(query, limit)
	if err != nil {
		return errResult(err.Error())
	}

	// Normalize scores to 0-100 for output.
	maxScore := 0.0
	for _, r := range bm25Results {
		if r.Score > maxScore {
			maxScore = r.Score
		}
	}

	// Convert BM25 results to the same format expected by consumers.
	results := make([]map[string]any, 0, len(bm25Results))
	for _, r := range bm25Results {
		item := map[string]any{
			"name":      r.Name,
			"full_name": fullName(r),
			"file":      r.Path,
			"line":      r.StartLine,
			"column":    r.StartCharacter,
			"kind":      r.Kind,
			"score":     normalizeScore(r.Score, maxScore),
			"body_location": map[string]int{
				"start_line": r.StartLine,
				"end_line":   r.EndLine,
			},
		}
		if verbose {
			item["signature"] = r.Signature
			item["snippet"] = r.Snippet
		}
		if includeBody {
			absPath := filepath.Join(root, r.Path)
			item["body"] = sourceForRange(absPath, lsp.Range{
				Start: lsp.Position{Line: r.StartLine - 1, Character: r.StartCharacter - 1},
				End:   lsp.Position{Line: r.EndLine - 1, Character: 0},
			})
		}
		results = append(results, item)
	}

	resp := map[string]any{"results": results, "total": len(results), "mode": publicMode}
	out, _ := json.MarshalIndent(resp, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func fullName(r search.CodeBM25Result) string {
	if r.Container != "" {
		return r.Container + "." + r.Name
	}
	return r.Name
}

func normalizeScore(score, maxScore float64) float64 {
	if maxScore <= 0 {
		return 0
	}
	n := score / maxScore
	if n > 1 {
		return 1
	}
	if n < 0.01 && score > 0 {
		return 0.01
	}
	return float64(int(n*10000+0.5)) / 10000
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

func findSymbolByName(symbols []lsp.DocumentSymbol, name string) (lsp.DocumentSymbol, bool, error) {
	name = strings.TrimSpace(name)
	parts := strings.Split(name, ".")
	if sym, ok := findSymbolByParts(symbols, parts); ok {
		return sym, true, nil
	}
	if name == "" || strings.Contains(name, ".") {
		return lsp.DocumentSymbol{}, false, nil
	}
	matches := collectBareSymbolMatches(symbols, name, nil)
	switch len(matches) {
	case 0:
		return lsp.DocumentSymbol{}, false, nil
	case 1:
		return matches[0], true, nil
	default:
		names := make([]string, 0, len(matches))
		for _, match := range matches {
			names = append(names, match.Name)
		}
		sort.Strings(names)
		return lsp.DocumentSymbol{}, false, fmt.Errorf("symbol %q is ambiguous; matches: %s", name, strings.Join(names, ", "))
	}
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

func collectBareSymbolMatches(symbols []lsp.DocumentSymbol, name string, matches []lsp.DocumentSymbol) []lsp.DocumentSymbol {
	for _, sym := range symbols {
		if isCallableSymbol(sym.Kind) && symbolBareName(sym.Name) == name {
			matches = append(matches, sym)
		}
		matches = collectBareSymbolMatches(sym.Children, name, matches)
	}
	return matches
}

func isCallableSymbol(kind int) bool {
	return kind == 6 || kind == 9 || kind == 12
}

func symbolBareName(name string) string {
	name = strings.TrimSpace(name)
	if idx := strings.Index(name, "("); idx >= 0 {
		name = name[:idx]
	}
	return strings.TrimSpace(name)
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
	if end > len(lines) {
		end = len(lines)
	}
	replacement := []string{}
	if body != "" {
		replacement = strings.Split(strings.TrimRight(body, "\n"), "\n")
	}
	next := append([]string{}, lines[:start]...)
	next = append(next, replacement...)
	next = append(next, lines[end:]...)
	return end - start, os.WriteFile(path, []byte(strings.Join(next, "\n")), 0644)
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

func notifyDidChange(ctx context.Context, session lsp.Session, path string) error {
	if session == nil {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return session.DidChange(ctx, path, string(data))
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

	// Try git ls-files first — much faster than WalkDir
	cmd := exec.CommandContext(context.Background(), "git", "ls-files", "--cached", "--others", "--exclude-standard")
	cmd.Dir = base
	out, err := cmd.Output()
	if err == nil && len(out) > 0 {
		lines := strings.Split(strings.TrimSpace(string(out)), "\n")
		files := make([]string, 0, len(lines))
		for _, line := range lines {
			if line == "" {
				continue
			}
			abs := filepath.Join(base, line)
			if isSourceFile(abs) {
				files = append(files, abs)
			}
			if len(files) >= 200 {
				break
			}
		}
		if len(files) > 0 {
			return files, nil
		}
	}

	// Fallback: WalkDir
	files := []string{}
	err = filepath.WalkDir(base, func(p string, d os.DirEntry, err error) error {
		if err != nil || len(files) >= 200 {
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

func buildFileSummaries(ctx context.Context, mgr CodeRuntime, root, absPath string) ([]search.CodeSummary, error) {
	var symbols []lsp.DocumentSymbol
	err := mgr.WithSession(ctx, absPath, func(session lsp.Session) error {
		var callErr error
		symbols, callErr = session.DocumentSymbols(ctx, absPath)
		return callErr
	})
	if err != nil {
		return nil, err
	}
	if len(symbols) == 0 {
		return nil, nil
	}

	data, err := os.ReadFile(absPath)
	if err != nil {
		return nil, err
	}
	relPath, _ := filepath.Rel(root, absPath)
	relPath = filepath.ToSlash(relPath)

	return search.BuildCodeSummaries(relPath, symbols, string(data)), nil
}
