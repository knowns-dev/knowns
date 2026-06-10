---
title: BM25 Lexical Search Backend
description: Specification for replacing heuristic keyword ranking with BM25-backed lexical search across knowledge and code discovery
createdAt: '2026-06-10T04:20:49.518Z'
updatedAt: '2026-06-10T07:50:31.908Z'
tags:
  - spec
  - approved
  - search
  - bm25
  - keyword
  - code-intelligence
---

## Overview

Add a BM25-backed lexical search backend for Knowns keyword search. The feature improves ranking quality for common-term, multi-word, and long-document queries while preserving the existing public search modes and exact lookup behavior.

BM25 must cover knowledge search over docs, tasks, and memories, and code discovery through lightweight LSP-derived symbol summaries. It must not introduce semantic embeddings for code and must not add code indexing work to default ingest.

Related references:
- @doc/research/keyword-search-benchmark-matrix
- @doc/specs/rag-retrieval-foundation
- @doc/specs/lsp-enriched-code-intelligence
- @memory-haz0cd

## Locked Decisions

- D1: BM25 scope covers knowledge search and code search/candidate discovery.
- D2: Code BM25 uses LSP-derived symbol summaries, not semantic embeddings, and does not add default code ingest.
- D3: BM25 replaces the backend of `keyword` mode; public modes remain `keyword`, `semantic`, and `hybrid`.
- D4: BM25 provides the base lexical score, while exact title/path/tag/category/source boosts remain as a rerank layer.
- D5: BM25 rollout uses shadow comparison against the current heuristic search before BM25 is accepted as the default keyword backend.
- D6: CLI `knowns code search` uses LSP DocumentSymbols when available, falls back to regex-based symbol extraction when LSP is unavailable.

## Requirements

### Functional Requirements

- FR-1: Keyword search must support BM25 lexical scoring for docs, tasks, and memories.
- FR-2: Keyword search must support BM25-style code discovery from LSP-derived symbol summaries.
- FR-3: Code discovery summaries must include available symbol evidence such as name, owner/type, interface or implementation context, signature, file path, package/module, comments/docstrings, and nearby or referenced symbols when available.
- FR-4: Code discovery must not use semantic embeddings.
- FR-5: Code discovery must not run as part of default `knowns ingest` or default runtime reindex jobs.
- FR-6: Existing public search modes must remain backward compatible: `keyword`, `semantic`, and `hybrid`.
- FR-7: `keyword` mode must use the BM25-backed lexical backend after rollout acceptance.
- FR-8: `hybrid` mode must continue to combine lexical and semantic results, with BM25 replacing the lexical side after rollout acceptance.
- FR-9: BM25 results must preserve `SearchResult` metadata including type, id/path, title, score, snippet, and `MatchedBy`.
- FR-10: `MatchedBy` for BM25-backed keyword results must remain compatible with existing consumers that expect `keyword`.
- FR-11: Exact title, exact path, strong tag/category, and source/type preference boosts must remain available as deterministic rerank signals on top of BM25.
- FR-12: The ranking layer must reduce known keyword failure modes from @doc/research/keyword-search-benchmark-matrix: common-term inflation, substring noise, long-doc bias, and task/doc skew.
- FR-13: The benchmark matrix must be converted or mirrored into a repeatable golden/shadow comparison test suite.
- FR-14: Shadow comparison must report heuristic-vs-BM25 ranking differences before BM25 becomes the accepted keyword backend.
- FR-15: BM25 code discovery must hand off selected results to existing LSP actions such as symbols, definition, references, implementations, and diagnostics rather than replacing LSP precision workflows.
- FR-16: MCP `code` action `find` must use BM25 ranking over LSP DocumentSymbols, replacing the previous workspace-symbol + symbolScore fallback.
- FR-17: CLI `knowns code search <query>` must provide BM25 lexical code search with `--path` scoping and `--json` output.

### Non-Functional Requirements

- NFR-1: Default ingest performance must not regress due to code BM25 discovery.
- NFR-2: Knowledge search latency must remain acceptable for normal interactive CLI/MCP/API use.
- NFR-3: Ranking behavior must be deterministic for the same repository state and query.
- NFR-4: BM25 scoring and rerank boosts must be inspectable enough for tests and debugging.
- NFR-5: The implementation must preserve existing CLI, MCP, and HTTP API compatibility unless explicitly revised by a later spec.
- NFR-6: BM25 must not introduce external model, ONNX, or vector-store dependencies for keyword/code discovery.
- NFR-7: CLI code search must not require LSP startup; regex fallback provides sub-second response for small scopes.

## Acceptance Criteria

- [x] AC-1: `keyword` search over docs/tasks/memories returns BM25-backed lexical results without requiring semantic search to be configured.
- [x] AC-2: Existing CLI, MCP, and HTTP callers using `mode=keyword` or `--keyword` continue to work without public API changes.
- [x] AC-3: `hybrid` search still combines lexical and semantic results, with BM25 providing the lexical candidates after rollout acceptance.
- [x] AC-4: Exact title/path queries from @doc/research/keyword-search-benchmark-matrix still rank expected strong results at or near the top.
- [x] AC-5: Common-term benchmark queries show reduced irrelevant long-doc/common-term domination compared with the heuristic baseline.
- [x] AC-6: Multi-word benchmark queries preserve or improve expected top results compared with the heuristic baseline.
- [x] AC-7: Short-token/substr benchmark queries reduce substring noise compared with the heuristic baseline.
- [x] AC-8: Code discovery can surface a method such as `login` when its LSP-derived context includes owner/interface/path evidence like `google_auth`, `common_auth`, or `auth`.
- [x] AC-9: Code discovery does not run during default `knowns ingest` or default runtime reindex jobs.
- [x] AC-10: BM25 code results provide enough source metadata for follow-up LSP navigation.
- [x] AC-11: Shadow comparison output identifies changed rankings and pass/partial/fail outcomes for benchmark cases before rollout.
- [x] AC-12: Tests cover BM25 tokenization, document length normalization, source field weighting/rerank boosts, and benchmark golden cases.

## Scenarios

### Scenario 1: Knowledge Keyword Search Uses BM25

**Given** semantic search is not configured
**When** a user runs keyword search for `search quality improvements`
**Then** Knowns ranks the expected search-quality spec strongly using BM25-backed lexical scoring.

### Scenario 2: Exact Lookup Remains Strong

**Given** BM25 is enabled as the keyword backend
**When** a user searches for `guides/semantic-search-guide`
**Then** the matching doc path ranks at or near the top because exact path boost remains active.

### Scenario 3: Common-Term Query Is Less Noisy

**Given** the benchmark query `search`
**When** BM25 shadow comparison runs against the heuristic baseline
**Then** the report shows whether common-term inflation and long-doc bias are reduced without hiding core search specs/guides/tasks.

### Scenario 4: Code Discovery From LSP Summary

**Given** a codebase contains a `login` method owned by `google_auth` implementing or relating to `common_auth`
**When** a user searches for `auth`
**Then** BM25 code discovery can return the `login` symbol based on owner/interface/path context, not semantic embeddings.

### Scenario 5: Default Ingest Is Unchanged

**Given** a project runs default ingest or runtime reindex
**When** BM25 is available
**Then** docs/tasks/memories may be indexed for lexical search, but code BM25 discovery does not add default ingest work.

### Scenario 6: Hybrid Search Uses BM25 Lexical Side

**Given** semantic search is configured
**When** a user runs default hybrid search
**Then** Knowns combines semantic results with BM25 lexical candidates and applies the deterministic rerank layer.

### Scenario 7: CLI Code Search Without LSP

**Given** LSP is unavailable or slow to start
**When** a user runs `knowns code search "login auth"`
**Then** CLI falls back to regex-based symbol extraction and BM25 ranking, returning results in under 2 seconds for typical project sizes.

## Technical Notes

Implementation should start from the current search flow in `internal/search/engine.go` and preserve the existing `SearchOptions`/`SearchResult` surface where possible.

### Architecture

- `internal/search/lexical_backend.go` — BM25 + heuristic keyword search implementations, `bm25LexicalBackend` with `k1=1.2`, `b=0.75`, field-weighted scoring (title=4.0, id=5.0, path=3.2, category=2.8, labels/tags=2.2, description=1.5-1.6, content=1.0-1.2)
- `internal/search/code_bm25.go` — `CodeSummary` model, `CodeBM25Scorer`, `BuildCodeSummaries` from LSP DocumentSymbols with symbol name, kind/owner, signature, path/package, comments, relationship context
- `internal/mcp/handlers/code.go` — `handleCodeFind` uses BM25 over LSP DocumentSymbols, replacing workspace-symbol + symbolScore fallback
- `internal/cli/code.go` — `knowns code search` CLI command with LSP→regex fallback, `--path` scoping, `--json` output
- `scripts/search_compare` — shadow comparison tool comparing heuristic vs BM25 through internal backends

### Key Implementation Details

- Introduce an internal lexical backend abstraction for heuristic vs BM25 during shadow comparison.
- Keep `MatchedBy: ["keyword"]` for compatibility even when BM25 backs keyword search.
- Convert @doc/research/keyword-search-benchmark-matrix into fixtures or golden tests outside normal searchable docs to avoid benchmark self-pollution.
- Use BM25 for base score, then apply deterministic rerank boosts for exact title/path/tag/category/source signals.
- Keep code discovery separate from default ingest; use LSP-derived symbol summaries on demand or through an opt-in lightweight cache.
- CLI `code search` extracts Go symbols via regex (`func`, `type`, `var/const`, preceding `//` comments) when LSP unavailable.

BM25 should be treated as lexical ranking, not semantic search. It should not replace LSP definition/reference/diagnostic workflows.

## Open Questions

- [ ] OQ-1: What exact acceptance threshold should shadow comparison require before BM25 becomes default keyword backend?
- [ ] OQ-2: Should the heuristic backend remain available through an internal debug flag after rollout?
- [ ] OQ-3: Should BM25 corpus statistics be persisted, rebuilt on demand, or computed in memory for the first implementation?
- [ ] OQ-4: What is the minimum LSP symbol summary schema for phase one code discovery?
