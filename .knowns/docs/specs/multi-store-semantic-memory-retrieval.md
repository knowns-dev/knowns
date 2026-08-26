---
id: doc-666bb99e354884b219ec964778f35b8a
title: Multi-Store Semantic Memory Retrieval
description: Specification for multi-store semantic memory retrieval across project and global stores with default model auto-setup during init and sync.
createdAt: '2026-04-11T22:16:32.404Z'
updatedAt: '2026-08-25T14:36:43.724Z'
tags:
  - spec
  - approved
  - semantic
  - memory
  - search
  - global
  - runtime
  - partially-superseded
---

# Multi-Store Semantic Memory Retrieval

## Overview

Define a multi-store semantic retrieval model for memory search and runtime-memory injection that queries both the current project store and the machine-level global memory store, then merges results at query time.

This spec also defines semantic auto-setup behavior for new stores: when a store does not yet have semantic search configured or ready, `knowns init` and `knowns sync` should automatically configure the recommended default model, download it if needed, and build the required index.

The purpose is to make semantic-backed memory retrieval actually usable across projects without duplicating global memory into every project index, while keeping runtime-memory and `knowns search --type memory` capable of using project and global memory together.

This spec extends @doc/specs/semantic-search and supports the runtime retrieval needs described in @doc/specs/runtime-memory-hook-injection.

## Locked Decisions

- D1: When `knowns init` or `knowns sync` sees that semantic search is enabled or needed but a store is not ready, it should automatically download the recommended model and build the index.
- D2: Semantic memory retrieval should query both the current project store and the global memory store, then merge results at query time.
- D3: When a store has no semantic config or model yet, `multilingual-e5-small` is the default semantic model Knowns should configure.
- D4: Global memories must be indexed in the global store only, not copied into each project store's vector index.
- D5: Store-local semantic models may differ between project and global stores; result merging must happen at the ranked-result layer, not at the embedding/vector layer.

## Requirements

### Functional Requirements

- FR-1: Memory retrieval for semantic and hybrid search must query both the active project store and the global memory store when both are available.
- FR-2: The system must merge ranked memory results from project and global stores at query time without duplicating global memory into project indices.
- FR-3: Runtime-memory retrieval must be able to use semantic-backed candidates from both project and global memory stores.
- FR-4: `knowns search --type memory` must support semantic and hybrid retrieval using both project and global memory stores.
- FR-5: When `--type memory` is used, semantic retrieval must apply type-aware filtering before or at the vector search stage so non-memory chunks do not crowd out memory candidates.
- FR-6: When a project store has semantic search enabled but is not ready, `knowns init` and `knowns sync` must ensure the store is configured with the default semantic model, download the model if missing, and build or refresh the index.
- FR-7: When the global store has semantic search enabled but is not ready, `knowns init` and `knowns sync` must ensure the global store is configured with the default semantic model, download the model if missing, and build or refresh the global memory index.
- FR-8: If a store has no semantic search configuration yet, Knowns must initialize it with `multilingual-e5-small` as the default model.
- FR-9: Query-time result merging must preserve source metadata so project and global memories remain distinguishable in output and reranking.
- FR-10: Result merging must not require project and global stores to share the same embedding model.
- FR-11: If semantic retrieval is unavailable for one store but available for another, the system must still query both stores using the best method available per store, then merge results.
- FR-12: If both stores lack usable semantic state, search and runtime-memory must fall back cleanly to keyword/heuristic behavior.
- FR-13: Status and diagnostic output must make it possible to tell whether project semantic state, global semantic state, or both are contributing to memory retrieval.
- FR-14: Global memory indexing must include all global memory entries in the machine-level Knowns store, not only newly created entries after semantic setup.
- FR-15: The implementation must avoid silently mutating or copying global memory into project-local vector stores.

### Non-Functional Requirements

- NFR-1: Multi-store retrieval must avoid unnecessary duplicate indexing work by keeping global memories in the global store only.
- NFR-2: Query-time merging should be based on normalized ranked results or rank fusion, not raw vector comparisons across stores with potentially different models.
- NFR-3: Automatic setup in `init` and `sync` must be idempotent; re-running them should converge on a ready semantic state without duplicating downloads or corrupting indices.
- NFR-4: Auto-setup should only occur in setup-oriented flows such as `init` and `sync`, not silently during prompt-time runtime hook execution.
- NFR-5: Type-specific semantic memory search must preserve recall for memory entries instead of letting unrelated doc/task chunks dominate Top-K selection.

## Acceptance Criteria

- [ ] AC-1: In a project with semantic search ready, `knowns search --type memory` can return memory results matched by `semantic` or `semantic+keyword` using both project and global memory stores.
- [ ] AC-2: Runtime-memory retrieval can select semantic-backed memory candidates from both project and global stores without copying global memories into the project index.
- [ ] AC-3: When a store is missing semantic config or model, `knowns init` or `knowns sync` configures `multilingual-e5-small`, downloads the model if necessary, and makes the store ready for semantic retrieval.
- [ ] AC-4: If the project store is semantic-ready but the global store is not, retrieval still works using semantic for project memory and the best available fallback for global memory.
- [ ] AC-5: If `--type memory` is specified, semantic memory candidates are not lost simply because doc/task chunks consumed the vector search Top-K before type filtering.
- [ ] AC-6: Result metadata and debug output make it visible whether a memory result came from the project store or the global store, and whether it was matched semantically or by fallback methods.
- [ ] AC-7: Re-running `knowns init` and `knowns sync` after setup does not duplicate model downloads or create duplicate memory indices.

## Scenarios

### Scenario 1: Fresh project init with no semantic store
**Given** a project store has no semantic configuration or index
**And** the global store also lacks semantic readiness
**When** the user runs `knowns init`
**Then** Knowns configures both stores to use `multilingual-e5-small`
**And** downloads the model if missing
**And** builds the project and global semantic indices

### Scenario 2: Project semantic ready, global semantic missing
**Given** the current project store is semantic-ready
**And** the global memory store is not yet indexed
**When** the user runs `knowns sync`
**Then** Knowns leaves the ready project index intact
**And** builds the global memory index
**And** future memory retrieval can query both stores

### Scenario 3: Memory search with type filter
**Given** both project and global stores contain indexed docs, tasks, and memories
**When** the user runs `knowns search --type memory <query>`
**Then** semantic retrieval only competes among memory chunks for the semantic memory lane
**And** memory results are not crowded out by doc or task chunks before filtering

### Scenario 4: Runtime-memory semantic retrieval
**Given** project and global memory stores are semantic-ready
**When** runtime-memory builds a pack for a prompt about a cross-project topic
**Then** it may select relevant project memories and relevant global memories together
**And** the output preserves which items came from project or global scope

### Scenario 5: Different models per store
**Given** the project store uses one embedding model and the global store uses another
**When** semantic memory retrieval runs
**Then** each store is queried with its own model/index
**And** results are merged by ranked-result logic rather than raw vector comparison

### Scenario 6: No semantic available anywhere
**Given** neither the project store nor the global store has usable semantic readiness
**When** memory retrieval runs
**Then** the system falls back to keyword or heuristic methods without failing the command or runtime hook

## Technical Notes

### Store Model

- Project-local semantic state remains under the active project's Knowns store.
- Global semantic state remains under the machine-level global Knowns store.
- Global memory entries should only be embedded and stored in the global vector store.

### Query Model

- Query project and global stores independently.
- Each store uses its own semantic configuration and embedding model.
- Merge results at the `SearchResult` / retrieval-candidate layer.
- Do not compare or combine raw vectors across stores.

### Auto-Setup Behavior

- `knowns init` and `knowns sync` are responsible for ensuring semantic readiness.
- Prompt-time commands such as runtime hooks should not trigger surprise model downloads.
- If a store has no semantic config yet, seed it with `multilingual-e5-small`.

### Retrieval Quality

- `--type memory` should constrain semantic retrieval early enough that non-memory chunks do not consume the semantic Top-K budget intended for memories.
- Runtime-memory should be able to use semantic-backed memory hits when available, then fall back per store when needed.

## Open Questions

- [ ] Should project and global stores contribute equal weight during rank fusion, or should project memory receive a small default boost?
- [ ] Should `knowns search --status-check` be extended to report project and global semantic readiness separately in one command?
- [ ] Should `knowns sync` always refresh global memory indexing, or only when global memory content/hash has changed?


## Superseded in Part

@doc/specs/2026-08-24/ollama-only-embedding supersedes part of this spec.

**Void:** FR-6 and FR-7 (model download during init and sync), FR-8 (`multilingual-e5-small` as the default model).

**Retained:** everything about multi-store retrieval and merging.

The System Decision recording this removal is not yet accepted — it stays draft until the removal is merged and a commit can be cited as evidence — and will be linked here once accepted.
