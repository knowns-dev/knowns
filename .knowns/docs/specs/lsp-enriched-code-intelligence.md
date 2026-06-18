---
title: LSP-Enriched Code Intelligence
description: Specification for replacing heuristic code graph with LSP-backed precise code intelligence, removing code embedding, and exposing LSP capabilities via MCP tools
createdAt: '2026-05-20T08:35:06.856Z'
updatedAt: '2026-06-15T04:28:40.168Z'
tags:
  - spec
  - approved
  - lsp
  - code-intelligence
  - mcp
---

## Overview

Replace the current heuristic tree-sitter edge resolution and code embedding pipeline with LSP-backed precise code intelligence. LSP servers provide exact cross-file references, definitions, and implementations — eliminating guesswork from the code graph and removing the need for ONNX embedding of code symbols entirely.

This spec also removes the code graph WebUI visualization and `code({ action: "graph" })` MCP tool, consolidating code intelligence into structured MCP tool actions.

## Locked Decisions

- D1: LSP enriches the code graph AND exposes real-time capabilities via existing `code({ action: "..." })` MCP tool — new actions: `references`, `definition`, `implementations`, `diagnostics`
- D2: Hybrid LSP lifecycle — servers start when MCP session begins, keep-alive during session, shutdown when no MCP clients remain connected
- D3: Auto-detect languages from project file extensions + check PATH for LSP binaries. Config override in `.knowns/config.json`. No binary found → report structured unavailable status/error with install guidance.
- D4: Remove code embedding entirely. Code search uses keyword matching + LSP-enriched graph traversal only. ONNX embedding reserved for docs/tasks/memories
- D5: Delegate workspace sync to LSP servers. Send `rootUri` on initialize, LSP server indexes workspace itself. On-demand `didOpen` (ref-counted) when querying specific files, `didClose` when done
- D6: Remove code graph visualization from WebUI
- D7: Remove `code({ action: "graph" })` MCP tool
- D8: `code({ action: "symbols" })` uses LSP-backed symbol data when available. If LSP is unavailable for the language, return a structured unavailable error rather than falling back to tree-sitter extraction.
- D9: Add `code({ action: "diagnostics" })` to expose LSP compile/type errors and warnings. Returns errors/warnings grouped by file, filterable by severity
- D10: No limit on concurrent LSP servers — start all detected languages. Practically rarely exceeds 4-5 servers
- D11: No TTL for edges. Delta detection handles staleness — file changed → re-enrich. Edges valid until file changes
## Requirements

### Functional Requirements

- FR-1: Knowns MUST spawn and manage LSP server processes (gopls, typescript-language-server, etc.) as child processes communicating via JSON-RPC over stdio
- FR-2: Knowns MUST auto-detect project languages by scanning file extensions and checking PATH for corresponding LSP binaries
- FR-3: Users MUST be able to override/disable language detection via `.knowns/config.json` (field: `lsp.languages`)
- FR-4: When no LSP binary is found for a language, Knowns MUST return structured unavailable status/errors with install guidance; it MUST NOT silently fall back to tree-sitter.
- FR-5: LSP servers MUST start when the first MCP client connects and shutdown when no clients remain
- FR-6: `code({ action: "search" })` MUST continue to work using keyword matching + graph traversal with LSP-enriched edges where available
- FR-7: New MCP action `code({ action: "definition" })` MUST return the exact file + location of a symbol's definition via LSP `textDocument/definition`
- FR-8: New MCP action `code({ action: "references" })` MUST return all references to a symbol via LSP `textDocument/references`
- FR-9: New MCP action `code({ action: "implementations" })` MUST return all implementations of an interface/abstract via LSP `textDocument/implementation`
- FR-10: New MCP action `code({ action: "diagnostics" })` MUST return compile/type errors and warnings from LSP, grouped by file, filterable by severity
- FR-11: Code embedding (ONNX inference for code chunks) MUST be removed from the indexing pipeline
- FR-12: Code graph visualization MUST be removed from WebUI
- FR-13: `code({ action: "graph" })` MCP tool MUST be removed
- FR-14: `code_edges` table MUST be retained and populated with LSP-resolved edges during background indexing
- FR-15: LSP workspace sync MUST delegate to the language server — send `rootUri` on initialize, use on-demand `didOpen`/`didClose` with ref-counting for queries
- FR-16: LSP servers that crash MUST be automatically restarted on next query (lazy restart)
- FR-17: `code({ action: "symbols" })` MUST use LSP-backed symbol data when available and return a structured unavailable error when no LSP capability is available for that language
- FR-18: No limit on concurrent LSP servers — start all detected languages
- FR-19: No TTL for cached edges — delta detection (file hash change) triggers re-enrichment
### Non-Functional Requirements

- NFR-1: LSP server startup MUST NOT block MCP tool responses; if a required server is unavailable or still initializing, actions MUST return structured pending/unavailable responses with guidance.
- NFR-2: Real-time LSP queries (`definition`, `references`, `implementations`, `diagnostics`) MUST respond within 5 seconds for typical files
- NFR-3: Background edge enrichment MUST be incremental — only re-query files that changed since last index (leverage existing delta detection from @doc/specs/delta-based-code-re-indexing)
- NFR-4: Memory usage of LSP servers SHOULD be monitored — log warnings if total exceeds configurable threshold
- NFR-5: The system MUST work on macOS, Linux, and Windows
## Acceptance Criteria

- [ ] AC-1: `code({ action: "definition", query: "functionName", path: "file.go" })` returns exact file + line of definition
- [ ] AC-2: `code({ action: "references", query: "functionName", path: "file.go" })` returns all call sites across the project
- [ ] AC-3: `code({ action: "implementations", query: "InterfaceName", path: "file.go" })` returns all implementing types
- [ ] AC-4: `code({ action: "diagnostics", path: "file.go" })` returns compile errors and warnings with line numbers and severity
- [ ] AC-5: `code({ action: "search" })` returns results using keyword + enriched graph (no embedding)
- [ ] AC-6: Running `knowns code search "query"` on a Go project with gopls installed produces results with resolved cross-file edges
- [ ] AC-7: Running on a project without the required LSP binary returns structured unavailable errors with install guidance and does not invoke tree-sitter
- [ ] AC-8: Code indexing no longer invokes ONNX embedding for code symbols
- [ ] AC-9: WebUI no longer shows code graph visualization page/component
- [ ] AC-10: `code({ action: "graph" })` returns an error or is not listed in available actions
- [ ] AC-11: LSP servers start on first MCP connection and stop when last client disconnects
- [ ] AC-12: If gopls crashes mid-session, next `code()` call restarts it transparently
- [ ] AC-13: `.knowns/config.json` supports `lsp.languages` override (enable/disable specific languages)
- [ ] AC-14: `code({ action: "symbols" })` returns enriched symbol data (type info, visibility) when LSP available
- [ ] AC-15: `code({ action: "deps" })` continues to work with enriched edge data
## Scenarios

### Scenario 1: Agent queries function references

**Given** a Go project with gopls installed and LSP server running
**When** agent calls `code({ action: "references", query: "HandleAuth", path: "internal/auth/handler.go" })`
**Then** returns all files and locations that call `HandleAuth`, with exact line numbers

### Scenario 2: No LSP available

**Given** a Rust project with no rust-analyzer on PATH
**When** agent calls an LSP-backed code action for Rust
**Then** Knowns returns a structured unavailable error with install guidance
**And** Knowns does not invoke tree-sitter.

### Scenario 3: LSP server crash recovery

**Given** gopls crashes during a session
**When** agent calls `code({ action: "definition", ... })`
**Then** Knowns detects the dead process, restarts gopls, retries the query, returns result

### Scenario 4: First-time project with mixed languages

**Given** a project with `.go`, `.ts`, and `.py` files
**When** MCP session starts
**Then** Knowns detects Go + TypeScript + Python, checks PATH for gopls/typescript-language-server/pylsp, starts only those found, logs which languages have LSP support, and reports unavailable status for missing servers

### Scenario 5: Code search without embedding

**Given** code index has been built (symbols + LSP-enriched edges, no embeddings)
**When** agent calls `code({ action: "search", query: "authentication middleware" })`
**Then** keyword matching finds relevant symbols, graph traversal expands neighbors via precise edges where available, returns ranked results

### Scenario 6: Config override disables a language

**Given** `.knowns/config.json` contains `{ "lsp": { "languages": { "typescript": false } } }`
**When** MCP session starts on a project with .ts and .go files
**Then** only gopls is started
**And** TypeScript LSP-backed code intelligence reports disabled/unavailable status without invoking tree-sitter

### Scenario 7: Agent checks diagnostics after edit

**Given** agent just modified `internal/auth/handler.go`
**When** agent calls `code({ action: "diagnostics", path: "internal/auth/handler.go" })`
**Then** returns any type errors or warnings from gopls without needing to run `go build`

## Technical Notes

### LSP Client Implementation

- Use Go LSP libraries: `go.lsp.dev/protocol` for types, `go.lsp.dev/jsonrpc2` for transport
- Each language server runs as a child process communicating via stdio JSON-RPC
- LSP manager routes queries to correct server based on file extension
- On-demand `didOpen`/`didClose` with ref-counting per file

### Language Registry (built-in)

| Language | Extensions | Binary | Check |
|----------|-----------|--------|-------|
| Go | .go | `gopls` | `gopls version` |
| TypeScript/JavaScript | .ts, .tsx, .js, .jsx | `typescript-language-server` | `--version` |
| Python | .py | `pylsp` or `pyright-langserver` | version check |
| Rust | .rs | `rust-analyzer` | `rust-analyzer --version` |

Extensible via `.knowns/config.json` `lsp.languages` field.

### Migration Path

1. Phase 1: Add LSP client infrastructure + new MCP actions (`definition`, `references`, `implementations`, `diagnostics`) — additive, no breaking changes
2. Phase 2: Remove code embedding from indexing pipeline
3. Phase 3: Remove WebUI graph visualization + `graph` action
4. Phase 4: Background edge enrichment via LSP (replace heuristic edges) + symbol enrichment

### Relationship to Existing Specs

- @doc/specs/delta-based-code-re-indexing — reuse delta detection for incremental LSP re-enrichment
- @doc/specs/ast-code-intelligence — this spec supersedes the edge resolution parts
- @doc/specs/remove-tree-sitter-lsp-only-code-intelligence — later design removes tree-sitter from code intelligence; LSP-backed code intelligence should return structured unavailable errors when required LSP capability is missing

## Open Questions

None — all resolved during exploration phase.
