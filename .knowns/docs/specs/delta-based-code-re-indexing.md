---
title: Delta-based Code Re-indexing
description: Specification for two-tier delta detection in knowns code ingest — file hash skips parse, chunk hash skips embed
createdAt: '2026-05-04T08:42:52.856Z'
updatedAt: '2026-05-04T15:53:02.821Z'
tags:
  - spec
  - approved
  - code-intelligence
  - performance
  - ingest
---

## Overview

`knowns code ingest` currently re-parses every file and re-embeds every symbol on every run. On a ~3700-symbol repo this takes ~17s after batch optimization. For larger repos or frequent re-runs (e.g., after a single file edit), most of that work is wasted — the vast majority of files and symbols haven't changed.

This spec introduces two-tier delta detection: file-level hashes skip parsing entirely for unchanged files, and chunk-level content hashes skip re-embedding for unchanged symbols within changed files. The goal is sub-second re-ingest when only a few files have changed.

Inspired by [CocoIndex Code](https://github.com/cocoindex-io/cocoindex-code)'s incremental indexing approach (80–90% cache hits on re-index), adapted to Knowns' richer pipeline (edges, graph, refs).

## Locked Decisions

- D1: **Two-tier delta detection** — SHA-256 file hash to skip parse; SHA-256 chunk content hash to skip re-embed. Both tiers active on every `knowns code ingest` run.
- D2: **Storage in `code_file_hashes` table** — New SQLite table in `index.db` with columns: `file_path TEXT PRIMARY KEY`, `file_hash TEXT`, `chunk_hashes TEXT` (JSON map of chunk_id → content_hash). Transactional with vector store operations.
- D3: **Always re-resolve all edges** — After delta parse/embed, run full `ResolveCodeEdges` on the complete symbol set (cached + new). Edge resolution is CPU-only string matching (~ms), not a bottleneck.
- D4: **Scope limited to `knowns code ingest`** — No watch integration in this spec. `knowns watch` auto-ingest is a separate follow-up.

## Requirements

### Functional Requirements

- FR-1: On `knowns code ingest`, compute SHA-256 hash of each candidate file's content. Compare against stored `file_hash` in `code_file_hashes`. Skip parsing for files whose hash matches.
- FR-2: For files whose hash changed (or are new), parse with tree-sitter as today. Compute SHA-256 of each symbol's embedding content (the `Content` field after `enrichCodeSymbolContent`). Compare against stored `chunk_hashes`. Skip embedding for symbols whose content hash matches.
- FR-3: Remove vector store entries for symbols that existed in the previous run but no longer exist (deleted files or removed symbols within changed files).
- FR-4: After delta embed completes, merge cached symbols with newly parsed symbols and run full `ResolveCodeEdges` + `SaveCodeEdges` on the complete set.
- FR-5: Update `code_file_hashes` table with new file hashes and chunk hashes after successful ingest.
- FR-6: First run on a project with no `code_file_hashes` table behaves identically to current full ingest (table is created and populated).
- FR-7: `knowns code ingest --full` flag forces a full re-ingest, ignoring all cached hashes (useful for debugging or after model changes).
- FR-8: Progress bar accurately reflects actual work — show "N files unchanged, M files to process" and only count files/symbols that need work in the progress total.

### Non-Functional Requirements

- NFR-1: Delta ingest of 1 changed file in a 3700-symbol repo completes in under 2 seconds (excluding model cold-start).
- NFR-2: Full ingest performance does not regress — hash computation overhead is negligible compared to embedding time.
- NFR-3: `code_file_hashes` table adds less than 1MB storage overhead for a 5000-file project.
- NFR-4: Hash comparison is deterministic — same file content always produces same hash, regardless of OS line endings or filesystem metadata.

## Acceptance Criteria

- [ ] AC-1: Running `knowns code ingest` twice on an unchanged repo — second run completes in under 1 second and reports "0 files changed".
- [ ] AC-2: Editing 1 file and running `knowns code ingest` — only that file is re-parsed and only its changed symbols are re-embedded. Other files' embeddings are preserved.
- [ ] AC-3: Deleting a file and running `knowns code ingest` — symbols from the deleted file are removed from vector store and `code_file_hashes`.
- [ ] AC-4: Adding a new file and running `knowns code ingest` — new file is parsed, embedded, and added to `code_file_hashes`.
- [ ] AC-5: `knowns code ingest --full` ignores all cached hashes and re-processes everything.
- [ ] AC-6: First run on a fresh project (no `code_file_hashes` table) creates the table and completes full ingest as before.
- [ ] AC-7: Edge resolution produces identical results to current full ingest — no missing or phantom edges.
- [ ] AC-8: Progress bar shows meaningful delta stats: "X files unchanged, Y files to process, Z symbols to embed".
- [ ] AC-9: Renaming a symbol within a file → old symbol removed from vector store, new symbol embedded, edges updated.

## Scenarios

### Scenario 1: No changes (Happy Path)
**Given** a project that was previously ingested with no file changes since
**When** user runs `knowns code ingest`
**Then** all files match cached hashes, 0 files are parsed, 0 symbols are embedded, edges are re-resolved from cached symbols, completes in under 1 second

### Scenario 2: Single file edit
**Given** a previously ingested project where user edited `src/api/handler.go`
**When** user runs `knowns code ingest`
**Then** only `src/api/handler.go` is re-parsed, only symbols with changed content are re-embedded, all other files' embeddings are preserved, edges are fully re-resolved

### Scenario 3: File deleted
**Given** a previously ingested project where user deleted `src/old/legacy.go`
**When** user runs `knowns code ingest`
**Then** all `code::src/old/legacy.go::*` entries are removed from vector store, `legacy.go` row is removed from `code_file_hashes`, edges referencing deleted symbols are cleaned up

### Scenario 4: New file added
**Given** a previously ingested project where user created `src/new/feature.go`
**When** user runs `knowns code ingest`
**Then** `feature.go` is parsed and all its symbols are embedded, new row added to `code_file_hashes`, edges include new symbols

### Scenario 5: Force full re-ingest
**Given** a previously ingested project
**When** user runs `knowns code ingest --full`
**Then** all files are re-parsed and all symbols are re-embedded regardless of cached hashes, `code_file_hashes` is fully refreshed

### Scenario 6: First run (no cache)
**Given** a project that has never been ingested (no `code_file_hashes` table)
**When** user runs `knowns code ingest`
**Then** table is created via migration, full ingest runs as today, all hashes are stored for next run

### Scenario 7: Embedding model changed
**Given** user changed embedding model in config after a previous ingest
**When** user runs `knowns code ingest`
**Then** system detects model change (model name stored in metadata), forces full re-embed while preserving file-level parse cache

## Technical Notes

### Current pipeline (to be modified)
```
listCodeCandidateFiles → IndexAllFilesWithProgress (parse ALL) →
RemoveByPrefix("code::") → batch embed ALL → Save → ResolveCodeEdges → SaveCodeEdges
```

### Proposed pipeline
```
listCodeCandidateFiles → loadFileHashes →
  for each file:
    if file_hash matches → load cached symbols (skip parse)
    else → parse file → compute chunk hashes →
      for each symbol:
        if chunk_hash matches → reuse cached embedding
        else → queue for embedding
  detect deleted files → remove from vector store
  batch embed changed symbols only →
  merge all symbols → ResolveCodeEdges → SaveCodeEdges →
  update code_file_hashes
```

### Key files to modify
- `internal/search/ast_indexer.go` — Add hash computation, delta detection logic
- `internal/cli/ingest.go` — Modify `runIngestWithProgress` to use delta pipeline
- `internal/search/store.go` or migration — Add `code_file_hashes` table schema
- `internal/search/semantic_store.go` — Add selective removal (by specific chunk IDs, not just prefix)

### Schema for `code_file_hashes`
```sql
CREATE TABLE IF NOT EXISTS code_file_hashes (
  file_path TEXT PRIMARY KEY,
  file_hash TEXT NOT NULL,
  chunk_hashes TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Chunk hash computation
Hash is computed on the enriched `Content` field (after `enrichCodeSymbolContent`), which includes signature + edge summary. This means if a function's callers change (edge change), the content hash changes and the symbol gets re-embedded — correct behavior since the embedding should reflect the updated context.

**Important caveat:** Since enriched content includes edge summaries, and edges depend on ALL symbols, a change in file A could change the enriched content of symbols in file B (if B calls something in A that was renamed). This is handled correctly because:
1. File A's hash changes → A is re-parsed → new symbols extracted
2. Full edge re-resolution runs on all symbols
3. Enriched content is recomputed for all symbols
4. Chunk hashes are compared AFTER enrichment → B's affected symbols get new hashes → re-embedded

This means chunk-level hash comparison must happen AFTER enrichment, not before.

## Open Questions

- [ ] Should we store the embedding model name in `code_file_hashes` metadata to auto-detect model changes and force re-embed?
- [ ] Should `code_file_hashes` also store symbol metadata (kind, signature) to enable faster `code_symbols` queries without loading the vector store?
