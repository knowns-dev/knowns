---
id: doc-32a5ac317e8295e650a93ddf1c03075f
title: AST Code Intelligence
description: Specification for AST-based code indexing, search, watching, ref system, and graph integration
createdAt: '2026-04-04T10:02:50.950Z'
updatedAt: '2026-04-06T07:01:34.104Z'
tags:
  - spec
  - approved
  - ast
  - search
  - graph
---

## Overview

AST Code Intelligence adds a code-awareness layer to Knowns. When an AI agent searches for
`"google oauth login"`, it receives not only tasks and docs but also the exact functions,
classes, and files where that feature lives — no guessing required.

The feature is **completely opt-in**: users who never run `knowns ingest` see zero behavior
change. Non-tech projects are unaffected.

The feature ships in three phases:
- **Phase 1** — Indexing: `knowns ingest`, `knowns watch`, `knowns browser --watch`
- **Phase 2** — Ref system: `@code/<filepath>::<symbol>` syntax in docs and tasks
- **Phase 3** — Search + Graph: code nodes in search results and knowledge graph UI

---

## Locked Decisions

- **D1:** All three phases are in scope for this spec.
- **D2:** `go-tree-sitter` is the unified AST parser for Go, TypeScript, JavaScript, and Python. No `go/ast` dependency.
- **D3:** Graph changes include both the backend API (`?includeCode=true`) and the Cytoscape frontend (purple nodes, "Show code" toggle, default off).
- **D4:** `knowns watch` monitors code files only. Docs and tasks are already re-indexed by their respective CLI commands.

---

## Requirements

### Functional Requirements

#### Phase 1 — Indexing

- **FR-1:** `knowns ingest` walks the project directory, respects `.gitignore` and any ignore
  list in `.knowns/config.json`, parses AST using go-tree-sitter, and stores code chunks in
  the existing SQLite `index.db`.
- **FR-2:** `knowns ingest --dry-run` prints what would be indexed without writing anything.
- **FR-3:** Parsed symbols are stored as `ChunkType = "code"` chunks with:
  - `ID` = `"code::<filepath>::<symbol>"` (file-level: `"code::<filepath>::__file__"`)
  - `DocPath` = relative file path
  - `Field` = `"function"` | `"class"` | `"method"` | `"interface"` | `"file"`
  - `Content` = natural-language description: `"<signature> — file: <path> — calls: <...> — imported by: <...>"`
- **FR-4:** AST edges (calls, imports, contains) are stored in a new `code_edges` table in `index.db`.
- **FR-5:** Supported languages: Go, TypeScript, JavaScript, Python.
- **FR-6:** `knowns watch` starts a background file watcher (fsnotify) for code files in the project root.
  - `CREATE` / `WRITE` → `BestEffortIndexFile(store, path)`
  - `RENAME` → `BestEffortRemoveFile(old)` + `BestEffortIndexFile(new)`
  - `DELETE` → `BestEffortRemoveFile(path)`
  - Default debounce: 1500ms. Configurable via `--debounce <ms>`.
- **FR-7:** `knowns browser --watch` runs the web UI server and the file watcher in the same
  process. When the browser server stops, the watcher goroutine stops with it.

#### Phase 2 — Ref System

- **FR-8:** Docs and tasks support `@code/<filepath>` (file ref) and
  `@code/<filepath>::<symbol>` (symbol ref) syntax.
- **FR-9:** `knowns validate` reports broken `@code/` refs as errors when the AST index
  exists (i.e., `code_edges` table has rows). If the AST index does not exist, `@code/` refs
  are silently skipped — no error.
- **FR-10:** Valid `@code/` refs in doc or task content create `"code-ref"` edges in the
  knowledge graph.

#### Phase 3 — Search + Graph

- **FR-11:** `knowns search` includes code chunks in results when the AST index exists.
  `--type code` filters to code results only. `--type all` (default) includes code if indexed.
- **FR-12:** The MCP `search` tool `type` enum adds `"code"` as a valid value.
- **FR-13:** `GET /api/graph?includeCode=true` returns code nodes (from `chunks` WHERE
  `type='code'`) and code edges (from `code_edges` table) in addition to tasks, docs, and memories.
- **FR-14:** `GET /api/graph` (default, `includeCode` omitted or `false`) returns no code
  nodes — existing behavior is unchanged.
- **FR-15:** The graph UI has a "Show code" toggle (default off). When toggled on, the UI
  re-fetches with `?includeCode=true` and renders code nodes in purple, distinct from
  task/doc/memory nodes.
- **FR-16:** `reindex_search` (MCP tool) preserves code chunks when the AST index exists:
  after rebuilding task + doc index, it detects `code_edges` rows and re-runs
  `IndexAllFiles(projectRoot)`. Response includes `codeFileCount` and `codeChunkCount` fields.

### Non-Functional Requirements

- **NFR-1:** User who has never run `knowns ingest` sees zero behavior change across all
  existing commands (`search`, `browser`, MCP tools, `validate`).
- **NFR-2:** `knowns ingest` on a medium project (≤5 000 files) completes in under 60s.
- **NFR-3:** `knowns watch` re-indexes a changed file within 2s of the debounce window.
- **NFR-4:** No new runtime dependency beyond go-tree-sitter and fsnotify.
- **NFR-5:** Code chunks reuse the existing ONNX embedding model — no new embedding dependency.

---

## Acceptance Criteria

- [ ] AC-1: `knowns ingest` on a Go project indexes functions and files into SQLite `index.db`.
- [ ] AC-2: `knowns ingest --dry-run` prints indexed symbols without writing to disk.
- [ ] AC-3: `knowns search "google oauth"` returns code nodes when AST index exists; returns no code nodes when it does not.
- [ ] AC-4: `knowns watch` detects a file save and re-indexes within 2s (after 1500ms debounce).
- [ ] AC-5: `knowns browser --watch` serves the web UI and auto-indexes on file changes in one process.
- [ ] AC-6: `@code/src/auth/jwt.go::verifyToken` in a doc creates a `"code-ref"` edge visible at `GET /api/graph?includeCode=true`.
- [ ] AC-7: `knowns validate` reports a broken `@code/` ref as an error when AST index exists; silently skips it when AST index does not exist.
- [ ] AC-8: `reindex_search` preserves code chunks when AST index exists; response includes `codeFileCount` and `codeChunkCount`.
- [ ] AC-9: `GET /api/graph` (no param) returns no code nodes — existing graph behavior unchanged.
- [ ] AC-10: Graph UI "Show code" toggle is off by default; toggling on renders code nodes in purple.
- [ ] AC-11: No existing test breaks when `knowns ingest` has never been run.

---

## Scenarios

### Scenario 1: First-time ingestion (Happy Path)
**Given** a Go project with `.knowns/` initialized and ONNX runtime available  
**When** user runs `knowns ingest`  
**Then** all Go functions, classes, and files are indexed into `index.db`; `code_edges` table is populated; subsequent `knowns search "token"` returns code nodes alongside tasks and docs

### Scenario 2: File watcher detects change
**Given** `knowns watch` is running and AST index exists  
**When** user saves a supported source file such as `internal/auth/jwt.go`  
**Then** within 2s the file is re-indexed and old chunks for that file are removed and replaced

### Scenario 3: Opt-in isolation
**Given** a project where `knowns ingest` has never been run  
**When** user runs `knowns search "auth"`, `knowns validate`, or calls MCP `search`  
**Then** results and behavior are identical to today — no code nodes, no errors

### Scenario 4: reindex_search preserves code index
**Given** AST index exists (code_edges has rows)  
**When** MCP `reindex_search` is called  
**Then** task + doc index is rebuilt AND code files are re-indexed; response contains `codeFileCount` and `codeChunkCount`

### Scenario 5: Broken @code/ ref
**Given** doc contains `@code/src/auth/jwt.go::verifyToken` and AST index exists but that symbol was deleted  
**When** user runs `knowns validate`  
**Then** error is reported: `Broken code ref: @code/src/auth/jwt.go::verifyToken (symbol not found in AST index)`

### Scenario 6: Graph with code nodes
**Given** AST index exists and a doc references `@code/src/auth/jwt.go::verifyToken`  
**When** `GET /api/graph?includeCode=true`  
**Then** response includes code nodes (type="code"), `code_edges` edges (calls/imports/contains), and a `code-ref` edge from the doc node to the code node

---

## Technical Notes

- `code_edges` table lives in `index.db` alongside `chunks`. @code/internal/search/sqlite_vecstore.go `Save()` only touches `chunks`, `metadata`, `content_hashes` — `code_edges` survives incremental saves.
- Reindex Phase 5 (code): check `code_edges` table for rows; if present, call @code/internal/search/ast_indexer.go::IndexAllFiles before final save. This handles the `reindex_search` and model-change rebuild paths.
- `indexEntry` has no `MemoryID` / `MemoryLayer` — code chunks encode all info in `ID`, `DocPath`, and `Field`. No schema changes needed beyond @code/internal/search/sqlite_vecstore.go.
- New files introduced by this spec: @code/internal/search/ast_indexer.go, @code/internal/cli/ingest.go, @code/internal/cli/watch.go.
- CLI registration follows the existing root command pattern used in @code/internal/cli/browser.go.

---

- [x] OQ-1: `knowns ingest` skips test files (`*_test.go`, `*.spec.ts`, `*.test.js`) by default. Opt-in via `--include-tests` flag. → **Resolved: skip by default**
- [x] OQ-2: go-tree-sitter grammar binaries are bundled into the binary at build time (CGO). Zero setup for users, binary size increase ~10–20MB acceptable. → **Resolved: bundled**
- [x] OQ-3: When embedding model changes and `Clear()` is called, `Reindex()` prints a warning: `"Code index cleared due to model change. Re-run knowns ingest to restore."` → **Resolved: warn**
