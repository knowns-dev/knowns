---
id: doc-c8629e7e992d711b5a9cde0f3e846348
title: Remove Tree-sitter, LSP-Only Code Intelligence
description: Specification for removing tree-sitter dependency and switching to LSP-only code intelligence with real-time queries, adding code editing actions (rename, replace, replace_symbol_body)
createdAt: '2026-05-20T18:12:39.553Z'
updatedAt: '2026-05-20T18:16:53.707Z'
tags:
  - spec,draft,lsp,code-intelligence
---

## Overview

Remove tree-sitter dependency entirely and switch to LSP-only code intelligence. All code queries (symbols, definition, references, implementations, diagnostics) use LSP servers in real-time. No background code indexing, no SQLite code tables, no tree-sitter parsing.

Additionally, add code editing capabilities via MCP: rename (LSP workspace/rename), replace (regex/literal file edit), and replace_symbol_body (replace entire function/method body by symbol name).

## Locked Decisions

- D1: LSP real-time only — no keyword search, no background code indexing. Code intelligence is live queries to LSP servers
- D2: Remove `code_symbols` and `code_edges` SQLite tables entirely, including migration and storage code
- D3: Keep `knowns ingest` but only for docs/tasks/memories. Remove all code indexing from ingest pipeline
- D4: MCP `code()` tool has 8 actions: `symbols`, `definition`, `references`, `implementations`, `diagnostics`, `rename`, `replace`, `replace_symbol_body`. Remove: `search`, `deps`, `graph`

## Requirements

### Functional Requirements

- FR-1: `code({ action: "symbols", path: "file.go" })` MUST call LSP `textDocument/documentSymbol` and return symbols with name, kind, range, and children hierarchy
- FR-2: `code({ action: "definition", path: "file.go", line: N, character: N })` MUST return exact definition location via LSP
- FR-3: `code({ action: "references", path: "file.go", line: N, character: N })` MUST return all references via LSP
- FR-4: `code({ action: "implementations", path: "file.go", line: N, character: N })` MUST return all implementations via LSP
- FR-5: `code({ action: "diagnostics", path: "file.go" })` MUST return errors/warnings from LSP
- FR-6: `code({ action: "rename", path: "file.go", line: N, character: N, newName: "X" })` MUST rename symbol across entire workspace via LSP `textDocument/rename` and apply all edits
- FR-7: `code({ action: "replace", path: "file.go", needle: "pattern", repl: "replacement", mode: "regex|literal" })` MUST replace content in file using regex or literal match
- FR-8: `code({ action: "replace_symbol_body", path: "file.go", symbol: "FuncName", body: "new code" })` MUST find symbol by name via LSP documentSymbol, then replace its entire body (from opening brace to closing brace)
- FR-9: All tree-sitter code MUST be removed: `ast_indexer*.go`, tree-sitter Go bindings, grammar files
- FR-10: `code_symbols` and `code_edges` SQLite tables MUST be dropped (migration)
- FR-11: `knowns ingest` MUST no longer index code — only docs/tasks/memories
- FR-12: `code({ action: "search" })`, `code({ action: "deps" })`, `code({ action: "graph" })` MUST be removed
- FR-13: If no LSP server is available for a file, code actions MUST return a clear error: "No LSP server available for <language>. Run: knowns lsp install <lang>"
- FR-14: `replace_symbol_body` MUST use LSP documentSymbol to find exact symbol range, then replace content between start and end of symbol body
- FR-15: `rename` MUST apply all workspace edits returned by LSP (multi-file rename)
- FR-16: `replace` MUST support `allow_multiple_occurrences` flag (default false — error if multiple matches)

### Non-Functional Requirements

- NFR-1: All code actions MUST respond within 5 seconds for typical files
- NFR-2: Binary size MUST decrease after removing tree-sitter (significant — tree-sitter grammars are large)
- NFR-3: `replace_symbol_body` MUST NOT corrupt file if symbol range is incorrect — validate before writing
- NFR-4: `rename` MUST NOT apply partial edits — all-or-nothing across files

## Acceptance Criteria

- [ ] AC-1: `code({ action: "symbols", path: "internal/lsp/manager.go" })` returns Manager struct + all methods with correct line numbers
- [ ] AC-2: `code({ action: "definition" })` returns same results as before (verified against Serena)
- [ ] AC-3: `code({ action: "references" })` returns same results as before (verified against Serena)
- [ ] AC-4: `code({ action: "implementations" })` returns same results as before
- [ ] AC-5: `code({ action: "diagnostics" })` returns compile errors
- [ ] AC-6: `code({ action: "rename", path: "file.go", line: 10, character: 5, newName: "NewName" })` renames symbol across all files
- [ ] AC-7: `code({ action: "replace", path: "file.go", needle: "oldFunc", repl: "newFunc", mode: "literal" })` replaces text in file
- [ ] AC-8: `code({ action: "replace_symbol_body", path: "file.go", symbol: "MyFunc", body: "func MyFunc() { return nil }" })` replaces entire function body
- [ ] AC-9: Tree-sitter imports/dependencies removed from go.mod
- [ ] AC-10: `code_symbols` and `code_edges` tables no longer exist in SQLite schema
- [ ] AC-11: `knowns ingest` does not touch code files
- [ ] AC-12: `code({ action: "search" })` returns error "action removed"
- [ ] AC-13: Binary size reduced (no tree-sitter grammars)
- [ ] AC-14: When no LSP available, actions return helpful error with install guidance
- [ ] AC-15: `replace` with regex mode and multiple matches + `allow_multiple_occurrences: false` returns error

## Scenarios

### Scenario 1: Agent explores file structure

**Given** a Go project with gopls running
**When** agent calls `code({ action: "symbols", path: "internal/lsp/manager.go" })`
**Then** returns hierarchical symbols: Manager struct with fields, NewManager function, all methods with line ranges

### Scenario 2: Agent renames a function

**Given** function `ServerForPath` exists in manager.go and is referenced in 5 other files
**When** agent calls `code({ action: "rename", path: "internal/lsp/manager.go", line: 65, character: 20, newName: "GetServerForPath" })`
**Then** all 6 files are updated, function renamed everywhere

### Scenario 3: Agent replaces function body

**Given** function `NewManager` exists in manager.go
**When** agent calls `code({ action: "replace_symbol_body", path: "internal/lsp/manager.go", symbol: "NewManager", body: "func NewManager(root string, cfg Config) *Manager {
	return &Manager{root: root}
}" })`
**Then** only NewManager body is replaced, rest of file unchanged

### Scenario 4: Agent does regex replace

**Given** file contains multiple `fmt.Println` calls
**When** agent calls `code({ action: "replace", path: "file.go", needle: "fmt\.Println\((.+?)\)", repl: "log.Info($1)", mode: "regex", allow_multiple_occurrences: true })`
**Then** all fmt.Println calls replaced with log.Info

### Scenario 5: No LSP available

**Given** a Python file exists but pylsp not installed
**When** agent calls `code({ action: "symbols", path: "script.py" })`
**Then** returns error: "No LSP server available for python. Run: knowns lsp install python"

### Scenario 6: Ingest only indexes docs

**Given** project has .go files and .md docs
**When** user runs `knowns ingest`
**Then** only docs/tasks/memories are indexed. No code parsing occurs. Completes faster than before.

## Technical Notes

### Files to remove

- `internal/search/ast_indexer.go`
- `internal/search/ast_indexer_edges.go`
- `internal/search/ast_indexer_implements.go`
- `internal/search/ast_indexer_parse.go`
- `internal/search/ast_indexer_resolve.go`
- `internal/search/ast_indexer_symbols.go`
- `internal/search/ast_indexer_windows.go`
- `internal/search/ast_indexer_test.go`
- `internal/search/lsp_enrichment.go` (no longer needed — LSP is primary, not enrichment)
- `internal/search/lsp_enrichment_test.go`
- `internal/search/code_neighbors.go` (depends on code_edges)
- `internal/storage/structural_edges.go`

### Files to modify

- `internal/mcp/handlers/code.go` — rewrite to use LSP directly, add rename/replace/replace_symbol_body
- `internal/cli/ingest.go` — remove code indexing calls
- `internal/search/runtime_jobs.go` — remove code indexing jobs
- `internal/search/sync.go` — remove code sync
- `internal/search/sqlite_vecstore.go` — remove code_symbols/code_edges table operations
- `internal/storage/store.go` — remove code table methods
- `internal/readiness/readiness.go` — remove code index readiness checks
- `go.mod` — remove tree-sitter dependencies

### go.mod dependencies to remove

- `github.com/smacker/go-tree-sitter`
- `github.com/tree-sitter/tree-sitter-go`
- `github.com/tree-sitter/tree-sitter-javascript`
- `github.com/tree-sitter/tree-sitter-python`
- `github.com/tree-sitter/tree-sitter-typescript`
- `github.com/tree-sitter/tree-sitter-c-sharp`
- `github.com/tree-sitter/tree-sitter-java`
- `github.com/tree-sitter/tree-sitter-rust`

### replace_symbol_body implementation

1. Call LSP `textDocument/documentSymbol` on the file
2. Find symbol by name in the hierarchy (support nested: "ClassName.MethodName")
3. Get symbol range (start line, end line)
4. Read file, replace lines from start to end with new body
5. Write file
6. Send `textDocument/didChange` to LSP server

### rename implementation

1. Call LSP `textDocument/rename` with position + new name
2. Receive `WorkspaceEdit` with changes per file
3. Apply all changes atomically (write all files)
4. If any file write fails, rollback all changes

## Open Questions

None — all resolved during exploration.


## Addendum: Naming & Documentation

### D5: Rename `replace_symbol_body` → `replace_body`

All references in this spec to `replace_symbol_body` should be read as `replace_body`. Final action list:
- `symbols`, `definition`, `references`, `implementations`, `diagnostics`, `rename`, `replace`, `replace_body`

### D6: Detailed per-action MCP descriptions

Each action MUST have its own description in the MCP tool schema explaining:
- What it does
- Required parameters
- Optional parameters
- Return format
- Example usage

Example schema description for `replace_body`:
```
Replace the entire body of a named symbol (function, method, struct).
Finds the symbol via LSP documentSymbol, then replaces from definition start to end.

Required: path, symbol (name or "Type.Method"), body (new source code)
Optional: none
Returns: { "success": true, "path": "...", "symbol": "...", "lines_changed": N }
```


## FR-17: Detailed MCP Tool Descriptions (All Tools)

All MCP tools MUST have detailed descriptions that help AI agents understand exactly what each action does, what parameters are required/optional, and what the return format is.

### Affected Tools

| Tool | Actions |
|------|---------|
| `code` | symbols, definition, references, implementations, diagnostics, rename, replace, replace_body |
| `docs` | create, get, update, delete, list, history |
| `tasks` | create, get, update, delete, list, history, board |
| `memory` | add, get, update, delete, list, promote, demote |
| `search` | search, retrieve, resolve |
| `templates` | create, get, list, run |
| `time` | start, stop, add, report |
| `project` | detect, current, set, status |
| `validate` | (single action, params-based) |

### Description Format

Each tool description MUST include:
1. One-line summary of the tool purpose
2. Per-action breakdown with: what it does, required params, optional params, return format
3. Brief example for complex actions

### Example (code tool)

```
Code intelligence operations. Use \action\ to specify: symbols, definition, references, implementations, diagnostics, rename, replace, replace_body.

- symbols: Get all symbols in a file (functions, types, methods). Required: path. Optional: none. Returns: hierarchical symbol list with name, kind, range, children.
- definition: Find where a symbol is defined. Required: path, line, character. Returns: location (file, line, character).
- references: Find all references to a symbol. Required: path, line, character. Returns: list of locations.
- implementations: Find all implementations of an interface. Required: path, line, character. Returns: list of locations.
- diagnostics: Get compile errors and warnings. Required: path. Optional: severity. Returns: list of diagnostics with message, severity, range.
- rename: Rename a symbol across the workspace. Required: path, line, character, newName. Returns: list of files changed.
- replace: Replace text in a file. Required: path, needle, repl, mode (regex|literal). Optional: allow_multiple_occurrences (default false). Returns: number of replacements.
- replace_body: Replace entire body of a named symbol. Required: path, symbol, body. Returns: success status.
```

### Acceptance Criteria (additional)

- [ ] AC-16: All 10 MCP tools have detailed per-action descriptions
- [ ] AC-17: AI agents can determine correct parameters without reading source code
- [ ] AC-18: Description visible in MCP tool listing (e.g. via `mcp.ListTools()`)
