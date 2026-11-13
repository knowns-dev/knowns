---
id: doc-e1ae0d44925bfa522ef6f465d2df9841
title: tree-sitter-sidecar
description: Migrate tree-sitter AST parsing from Go CGO bindings to TS/Bun sidecar via JSON-RPC
createdAt: '2026-04-18T17:29:29.428Z'
updatedAt: '2026-04-18T17:47:17.769Z'
tags:
  - spec
  - approved
  - sidecar
  - ast
  - tree-sitter
---

## Overview

Migrate AST parsing from Go tree-sitter CGO bindings to the existing TS/Bun sidecar (`knowns-embed`). The sidecar will gain a `parse` JSON-RPC method that returns raw symbols + edges for a single file; Go keeps all resolution, implements, and indexing logic. This removes CGO requirements from the Go build, enables Windows AST indexing for the first time, and unifies the sidecar distribution model already used for embeddings.

Reference implementation of the sidecar pattern (JSON-RPC stdio, binary discovery, lifecycle) lives in `internal/search/embedding_sidecar.go` and `sidecar/src/server.ts`.

## Locked Decisions

- **D1**: Full replace — remove Go tree-sitter bindings entirely (`github.com/tree-sitter/go-tree-sitter` and language bindings). Sidecar is the only parse path. No fallback.
- **D2**: Windows full parity — sidecar runs on all 6 platforms (darwin/linux/windows × x64/arm64). Windows gains AST indexing for the first time. `ast_indexer_windows.go` is deleted along with all build tags.
- **D3**: Perf threshold — reindex latency on a ~1000-file repo may be up to 3x slower than the Go baseline. Beyond 3x is a release blocker. Measured via a benchmark run in CI or locally before merge.
- **D4**: Sidecar parse-only — sidecar returns raw `CodeSymbol[]` and `CodeEdge[]` per file; Go keeps `ResolveCodeEdges`, `buildImplementsEdges`, `filterGraphCodeEdges`, `enrichCodeSymbolContent`, and all orchestration unchanged. No resolution logic ported to TS.

## Requirements

### Functional Requirements

- **FR-1**: Sidecar exposes a JSON-RPC method `parse` accepting `{ path: string, language: "go"|"javascript"|"typescript"|"tsx"|"python", source: string }` and returning `{ symbols: CodeSymbol[], edges: CodeEdge[] }`.
- **FR-2**: Sidecar uses `web-tree-sitter` (WASM) so no native/CGO dependency in the sidecar build itself.
- **FR-3**: WASM grammar files for Go/JS/TS/TSX/Python are bundled inside the compiled sidecar binary (via Bun `--compile` with `--asset`/embedded files) or shipped alongside it in the same distribution path.
- **FR-4**: Go `parseRawFile(docPath, absPath)` dispatches to sidecar and returns identical `[]CodeSymbol, []CodeEdge` shape as today; all downstream callers (`ast_indexer_symbols.go`, `ast_indexer_edges.go`) remain unchanged.
- **FR-5**: Go removes all tree-sitter imports, `go.mod` entries, and build tags (`//go:build !windows` / `//go:build windows`) for AST indexer files.
- **FR-6**: `ast_indexer_windows.go` is deleted; a single `ast_indexer_parse.go` works on all platforms.
- **FR-7**: Sidecar binary discovery and lifecycle reuse the existing `findSidecarBinary()` / process management from embedding path (shared connection with embedder).
- **FR-8**: If sidecar binary is missing, indexing fails with the same error surface as embedding today (`ErrSemanticRuntimeUnavailable`-style message).

### Non-Functional Requirements

- **NFR-1**: Reindex latency on a ~1000-file repo ≤ 3x the current Go-native baseline. Measured and reported in PR description.
- **NFR-2**: Per-file parse RPC latency ≤ 50ms P95 for files under 10 KB.
- **NFR-3**: No change to public Go API (`CodeSymbol`, `CodeEdge`, `parseRawFile` signature).
- **NFR-4**: Sidecar binary size increase ≤ 15 MB (WASM grammars are lightweight; tree-sitter WASM ~300-600 KB each × 5 languages).
- **NFR-5**: Go binary size decreases (no tree-sitter native code); target ≥ 5 MB reduction.
- **NFR-6**: Zero CGO required for `make build` after migration. `CGO_ENABLED=0` works on all platforms.

## Acceptance Criteria

- [ ] **AC-1**: `parse` JSON-RPC method implemented in sidecar and responds correctly for all 5 languages (go, javascript, typescript, tsx, python).
- [ ] **AC-2**: Sidecar embeds WASM grammars for all 5 languages; compiled binary starts without downloading grammars at runtime.
- [ ] **AC-3**: Go `parseRawFile` calls sidecar and returns symbols + edges matching the Go-native implementation on a reference corpus (golden-file test with ≥20 files per language).
- [ ] **AC-4**: All existing `ast_indexer_test.go` tests pass without modification (test reuses `parseRawFile`).
- [ ] **AC-5**: `github.com/tree-sitter/*` entries removed from `go.mod` and `go.sum`; `go mod tidy` is clean.
- [ ] **AC-6**: `ast_indexer_windows.go` deleted; `ast_indexer_parse.go` has no build tags.
- [ ] **AC-7**: `CGO_ENABLED=0 go build ./...` succeeds on darwin/linux/windows matrix.
- [ ] **AC-8**: Makefile `build`, `cross-compile`, `npm-build` targets updated to `CGO_ENABLED=0` with no warnings.
- [ ] **AC-9**: CI `publish.yml` matrix removes `cgo_enabled: "1"` entries and related cross-compiler setup (llvm-mingw for Windows).
- [ ] **AC-10**: Reindex benchmark on knowns-go repo itself completes within 3x the pre-migration baseline time, documented in PR body.
- [ ] **AC-11**: Windows x64 binary successfully indexes a sample Go project (manual smoke test).
- [ ] **AC-12**: No sidecar process leak — parse calls reuse the embedding sidecar process when available; single process per `StoreCtx`.

## Scenarios

### Scenario 1: Happy path — indexing a Go file

**Given** sidecar binary is installed alongside knowns and project contains `main.go`
**When** user runs `knowns code index`
**Then** Go reads `main.go`, sends `parse` RPC with language="go", receives symbols + edges, and writes them to the code index identical to pre-migration output.

### Scenario 2: Windows user first-time AST indexing

**Given** user on Windows x64 runs `knowns code index` for the first time post-migration
**When** index command executes
**Then** Windows now produces AST symbols and edges (previously empty); no error about CGO or tree-sitter bindings.

### Scenario 3: Sidecar missing

**Given** user installed knowns binary but deleted `knowns-embed` from the same directory
**When** user runs `knowns code index`
**Then** command fails with clear message: "semantic search is unavailable: knowns-embed sidecar binary not found"; no partial/corrupt index written.

### Scenario 4: Large file

**Given** a TypeScript file with 5000 lines
**When** `parseRawFile` is called
**Then** sidecar returns symbols + edges within the 60s default RPC timeout; no timeout or truncation.

### Scenario 5: Unsupported language

**Given** a `.rs` file is passed to `parseRawFile`
**When** parse is attempted
**Then** Go caller skips the file (as today — unsupported languages return `nil, nil, nil` without RPC).

### Scenario 6: Concurrent indexing

**Given** indexer processes 100 files concurrently via worker pool
**When** workers call `parseRawFile` in parallel
**Then** all calls serialize through the sidecar's existing `sync.Mutex`; no race; no stdout/stdin interleaving; throughput stays within NFR-1.

## Technical Notes

- Use `web-tree-sitter` npm package (WASM). Bundle `.wasm` grammar files via Bun's `--compile --asset` or write to a temp dir on first `init`.
- Parser instances per-language can be cached inside the sidecar across calls.
- The `CodeSymbol` and `CodeEdge` shapes are defined in Go — TS side mirrors them as plain objects and JSON-serializes.
- The existing `callWithTimeout` helper in `internal/search/embedding_sidecar.go` handles RPC; add a thin `Parse(...)` wrapper on the same `Embedder` struct (or rename it to `Sidecar`).
- Bun binary lookup: reuse `findSidecarBinary()`. No second binary.
- Edge resolution (`ResolveCodeEdges`, `buildImplementsEdges`) stays untouched in Go — sidecar only emits raw per-file output.

## Open Questions

- [x] **Q2 (RESOLVED):** WASM bundling strategy → Use Bun `import wasm from "./grammar.wasm" with { type: "file" }` import attribute. Bun `--compile` embeds the file into the standalone binary; runtime accesses via `Bun.file(path).arrayBuffer()` then `WebAssembly.instantiate()`. Total embedded size ~6MB (go 236KB + js 647KB + py 476KB + ts 2.3MB + tsx 2.4MB), well within NFR-4's 15MB budget. Source: https://bun.sh/docs/bundler/executables. Grammars come from `tree-sitter-wasms@0.1.13` npm package (no need to compile from source).
- [ ] Q1: Should sidecar accept source text or file path? (deferred to Task `0wrwco`)
- [ ] Q3: Batch RPC for multiple files? (deferred — single-file first, batch as optimization later)
- [ ] Q4: Rename Go struct `Embedder` → `Sidecar`? (deferred to Task `ugdz8o`)
