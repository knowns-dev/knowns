---
id: doc-15c506292139106a6932c41b7526610d
title: Semantic Search Quality Improvements
description: Specification for fixing chunking algorithm and embedding model prefix issues to improve semantic search quality
createdAt: '2026-04-01T08:02:49.337Z'
updatedAt: '2026-08-25T14:36:46.570Z'
tags:
  - spec
  - approved
  - search
  - embedding
  - chunking
  - partially-superseded
---

## Overview

Semantic search quality is degraded by six issues discovered during code review of `internal/search/` and RAG industry research (@doc/research/rag-chunking-strategies-research). This spec addresses missing model-specific prefixes, lost H1 content during chunking, inaccurate token estimation for non-English text, missing max_tokens enforcement for task chunks, lack of code block awareness in heading parser, and incomplete header hierarchy tracking.

Related: @doc/specs/semantic-search (original spec)

## Locked Decisions

- D1: Scope covers 6 issues — model prefix (high), H1 content loss (medium), EstimateTokens multilingual (medium), task chunk max_tokens split (medium), code block detection in heading parser (medium), full header path tracking (medium).
- D2: Config-driven prefix — add `QueryPrefix`/`DocPrefix` fields to `EmbeddingModelConfig`. Embedder exposes `EmbedQuery()` and `EmbedDocument()` methods that auto-prepend the correct prefix. Existing `Embed()` remains as raw (no prefix) for backward compat.
- D3: Use real tokenizer for token counting — chunker receives a tokenizer dependency to count tokens accurately instead of the `len(text)/4` heuristic. `EstimateTokens` remains as fallback when tokenizer is nil.
- D4: Auto-detect + reindex — store a `chunkVersion` in vector store metadata. On search init, compare stored version against current version constant. If outdated, auto-trigger reindex with progress logging.
- D5: Code block awareness — heading parser must track fenced code blocks and skip heading detection inside them. Follows LlamaIndex/LangChain pattern.
- D6: Full header path tracking — replace `parentSection` (H2-only) with a header stack that tracks the full hierarchy path (e.g., `"API/Endpoints/GET /users"`). Follows LlamaIndex `header_stack` pattern.

## Requirements

### Functional Requirements

- FR-1: Model-specific query/document prefixes must be applied during embedding. Models that require prefixes (bge-small-en-v1.5, bge-base-en-v1.5, nomic-embed-text-v1.5, multilingual-e5-small) must have their prefixes defined in `EmbeddingModelConfig` and applied automatically.
- FR-2: Document content between H1 and the first H2 must be captured during chunking, not silently dropped.
- FR-3: Token counting in the chunker must use the model's actual tokenizer when available, falling back to heuristic estimation only when tokenizer is nil.
- FR-4: Task chunks that exceed the model's max_tokens must be split by paragraph, matching the existing behavior for document chunks.
- FR-5: A chunk version constant must be maintained. When the stored version in the vector store differs from the current version, the system must auto-reindex on first search initialization.
- FR-6: The heading parser must detect fenced code blocks (triple-backtick delimiters) and skip heading detection inside them. Lines like `# comment` inside code blocks must not be treated as markdown headings.
- FR-7: Each chunk must track the full header hierarchy path (e.g., `"API/Endpoints/GET /users"`) using a header stack, replacing the current `parentSection` field that only tracks the nearest H2.

### Non-Functional Requirements

- NFR-1: Tokenizer-based counting must not add more than 50ms overhead per chunk on average (chunking is already I/O-bound by embedding).
- NFR-2: Auto-reindex must show progress to the user (reuse existing `ReindexProgress` callback).
- NFR-3: All changes must be backward-compatible — existing indexes work until auto-reindex runs.

## Acceptance Criteria

- [ ] AC-1: `EmbeddingModelConfig` has `QueryPrefix` and `DocPrefix` string fields. bge models use `"Represent this sentence: "` for queries. nomic uses `"search_query: "` / `"search_document: "`. e5 uses `"query: "` / `"passage: "`. gte and MiniLM have empty prefixes.
- [ ] AC-2: `Embedder` exposes `EmbedQuery(text string)` and `EmbedDocument(text string)` that prepend the appropriate prefix before embedding. `Embed()` remains unchanged (no prefix).
- [ ] AC-3: Search engine uses `EmbedQuery()` for query embedding. Index service uses `EmbedDocument()` for chunk embedding.
- [ ] AC-4: `ChunkDocument` captures content between H1 and the first H2 — either appended to the metadata chunk or as a separate chunk.
- [ ] AC-5: Chunker accepts an optional tokenizer. When provided, token counting uses `tokenizer.Encode()` length instead of `EstimateTokens()`.
- [ ] AC-6: `ChunkTask` splits fields that exceed max_tokens by paragraph, producing multiple chunks with `"(continued)"` suffix, matching `ChunkDocument` behavior.
- [ ] AC-7: A `ChunkVersion` constant exists (initial value: `2`). `SQLiteVectorStore` stores and checks this version. When version mismatch is detected during `InitSemantic`, auto-reindex is triggered.
- [ ] AC-8: `embedding_stub.go` (non-cgo build) compiles without errors — `EmbedQuery`/`EmbedDocument` stubs return `ErrSemanticRuntimeUnavailable`.
- [ ] AC-9: `extractHeadings` tracks fenced code block state (triple-backtick toggle). Headings inside code blocks are ignored. A document with `# comment` inside a code block produces zero heading chunks for that line.
- [ ] AC-10: `Chunk` struct replaces `ParentSection string` with `HeaderPath string` (e.g., `"API/Endpoints/GET /users"`). `extractHeadings` maintains a header stack that pops entries of equal or higher level when a new heading is encountered, producing the full path for each section.
- [ ] AC-11: `SQLiteVectorStore` schema migrates `parent_section` column to `header_path`. Existing indexes are rebuilt via auto-reindex (AC-7).
- [ ] AC-12: Existing unit tests pass. New tests cover: prefix application, H1 content capture, tokenizer-based counting, task chunk splitting, version-triggered reindex, code block heading skip, and header path hierarchy.

## Scenarios

### Scenario 1: Search with bge model (prefix applied)
**Given** semantic search is configured with `bge-small-en-v1.5`
**When** user searches for "authentication flow"
**Then** the query is embedded as `"Represent this sentence: authentication flow"` and documents were indexed with `"Represent this sentence: "` prefix

### Scenario 2: Document with content under H1
**Given** a document where text appears between the H1 title and the first H2 heading
**When** the document is chunked
**Then** that intro text is captured in the metadata chunk or a dedicated intro chunk — not silently dropped

### Scenario 3: Vietnamese task description
**Given** a task with a 2000-character Vietnamese description and model max_tokens=512
**When** the task is chunked with tokenizer available
**Then** token count is measured by tokenizer (likely ~800+ tokens for Vietnamese), and the description is split into multiple chunks each under 512 tokens

### Scenario 4: Long task notes split
**Given** a task with implementation notes exceeding max_tokens
**When** `ChunkTask` processes the task
**Then** the notes field produces multiple chunks split by paragraph, each within max_tokens

### Scenario 5: Upgrade triggers auto-reindex
**Given** user upgrades CLI from version with chunkVersion=1 to chunkVersion=2
**When** `InitSemantic` runs (on first search command)
**Then** system detects version mismatch, logs "Index outdated, rebuilding...", and runs full reindex automatically

### Scenario 6: gte model (no prefix)
**Given** semantic search is configured with `gte-small`
**When** query is embedded via `EmbedQuery()`
**Then** no prefix is prepended (QueryPrefix is empty string)

### Scenario 7: Heading inside code block ignored
**Given** a document containing a fenced code block with a line starting with `#` (e.g., a bash comment)
**When** the document is chunked
**Then** the `# comment` line inside the code block is NOT treated as a heading — only actual markdown headings outside code blocks produce heading chunks

### Scenario 8: Full header path tracking
**Given** a document with nested headings: H2 "API Reference" > H3 "Endpoints" > H4 "GET /users", and a sibling H3 "Authentication" > H4 "API Keys"
**When** the document is chunked
**Then** the chunk for "GET /users" has `HeaderPath = "API Reference/Endpoints/GET /users"`. The chunk for "API Keys" has `HeaderPath = "API Reference/Authentication/API Keys"`. When H3 "Authentication" appears, the stack pops "Endpoints" before pushing "Authentication".

## Technical Notes

### Files to modify
- @code/internal/search/types.go — add prefix fields to `EmbeddingModelConfig`, add `ChunkVersion` constant, replace `ParentSection` with `HeaderPath` in `Chunk`
- @code/internal/search/embedding_onnx.go — add `EmbedQuery()` / `EmbedDocument()` methods
- @code/internal/search/embedding_stub.go — add stub methods
- @code/internal/search/embedding_common.go — model prefix config values
- @code/internal/search/chunker.go — tokenizer dependency, H1 content fix, task chunk splitting, code block detection, header stack
- @code/internal/search/engine.go — use `EmbedQuery()` for search
- @code/internal/search/index.go — use `EmbedDocument()` for indexing, pass tokenizer to chunker
- @code/internal/search/init.go — version check + auto-reindex logic
- @code/internal/search/sqlite_vecstore.go — store/read `chunkVersion` in metadata, migrate `parent_section` to `header_path`

### Model prefix reference

| Model | QueryPrefix | DocPrefix |
|-------|------------|-----------|
| gte-small | (empty) | (empty) |
| all-MiniLM-L6-v2 | (empty) | (empty) |
| gte-base | (empty) | (empty) |
| bge-small-en-v1.5 | `"Represent this sentence: "` | `"Represent this sentence: "` |
| bge-base-en-v1.5 | `"Represent this sentence: "` | `"Represent this sentence: "` |
| nomic-embed-text-v1.5 | `"search_query: "` | `"search_document: "` |
| multilingual-e5-small | `"query: "` | `"passage: "` |
## Open Questions

- [ ] Should `Embed()` be deprecated or kept long-term? (Current plan: keep for backward compat)
- [ ] Should auto-reindex have a `--no-auto-reindex` flag for CI/scripting environments?


## Superseded in Part

@doc/specs/2026-08-24/ollama-only-embedding supersedes part of this spec.

**Void:** FR-3 and AC-5 (tokenizer-based token counting), and Scenario 3 — the tokenizer is removed along with the ONNX path.

**Void in part:** AC-1, for the local models that no longer exist.

**Retained:** the query/document prefix mechanism, which now applies to the HTTP provider, and the chunking requirements.

### Deliberate downgrade: FR-3

This is a deliberate downgrade, not an ordinary supersession. Removing the tokenizer downgrades token counting from exact to estimated for every provider, against FR-3's requirement for tokenizer-based exact counts. The estimator was improved separately to reduce the cost of this change, but it remains a downgrade and is recorded as one rather than silently absorbed.

The System Decision recording this removal is not yet accepted — it stays draft until the removal is merged and a commit can be cited as evidence — and will be linked here once accepted.
