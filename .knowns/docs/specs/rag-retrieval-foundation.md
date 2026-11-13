---
id: doc-2a30af804fc1ed691abd46c43f9ee402
title: RAG Retrieval Foundation
description: Specification for retrieval foundation across docs, tasks, and memories
createdAt: '2026-04-07T07:05:04.856Z'
updatedAt: '2026-04-07T07:06:56.535Z'
tags:
  - spec
  - approved
  - rag
  - retrieval
  - search
  - ai
---

## Overview

Build a shared retrieval foundation for Knowns that can retrieve from `docs`, `tasks`, and `memories`, rank mixed-source results, and assemble a reusable context pack for AI consumers.

This feature is not just a search improvement. It establishes a common retrieval layer for MCP/agent workflows and internal APIs so later workflows can request trustworthy, inspectable context without each consumer reimplementing retrieval logic.

Phase-one scope is limited to `docs`, `tasks`, and `memories`. `Graph-aware expansion` and `code context` are explicitly out of scope as required behavior in this spec, though the design should leave room for future extension.

## Locked Decisions

Decisions extracted during exploring phase:
- D1: Phase-one source scope includes `docs`, `tasks`, and `memories`.
- D2: The feature goal is a `RAG platform foundation`, not just better search UX or one workflow-specific helper.
- D3: Phase-one consumers must support both `MCP/agent workflows` and `internal APIs`.
- D4: Reference-based retrieval expansion is `optional expansion`; default retrieval does not auto-expand linked items.
- D5: When sources compete, `docs` are prioritized over `tasks` and `memories` in ranking/context assembly.
- D6: Phase-one output must include both `ranked candidates` and an `assembled context pack`.

## Requirements

### Functional Requirements
- FR-1: The system must provide a shared retrieval entrypoint that accepts a query and searches across `docs`, `tasks`, and `memories` in a single request.
- FR-2: The retrieval entrypoint must be available to both MCP/agent workflows and internal APIs.
- FR-3: The retrieval entrypoint must return a ranked candidate list that includes mixed-source results from supported source types.
- FR-4: Each ranked candidate must include source-identifying metadata sufficient for callers to inspect and cite the result, including at minimum source type, source ID/path, ranking score, and retrieval method.
- FR-5: The retrieval entrypoint must also return an assembled context pack built from the ranked candidates.
- FR-6: The context pack must preserve citations back to the originating doc, task, or memory entry for every included context item.
- FR-7: By default, retrieval must not expand references to linked items.
- FR-8: The retrieval entrypoint must support an explicit option for reference expansion so callers can request linked `docs`, `tasks`, and `memories` when needed.
- FR-9: When reference expansion is enabled, expanded items must remain attributable to the originating candidate or reference path so callers can distinguish direct matches from expanded context.
- FR-10: Ranking and context assembly must prefer `docs` over `tasks` and `memories` when multiple supported sources provide overlapping evidence for the same query.
- FR-11: The system must preserve source-type metadata in both ranked results and context pack output so callers can apply additional consumer-specific policies.
- FR-12: The retrieval response must allow callers to determine whether a context item came from a direct retrieval hit or from optional reference expansion.
- FR-13: The retrieval layer must support requests that disable any source type among `docs`, `tasks`, and `memories` so workflows can narrow context when needed.
- FR-14: The retrieval layer must behave deterministically for the same repository state, query, and retrieval options.
- FR-15: The retrieval layer must integrate with the existing Knowns search/indexing foundation rather than introducing a separate disconnected indexing system for phase one.

### Non-Functional Requirements
- NFR-1: The phase-one design must preserve backward compatibility for existing search/indexing data and commands where possible.
- NFR-2: The retrieval output must be inspectable and debuggable by humans, not only optimized for model consumption.
- NFR-3: The phase-one feature must keep mandatory scope limited to `docs`, `tasks`, and `memories`; `graph-aware expansion` and `code context` must remain optional future extensions.
- NFR-4: The feature must support incremental adoption so existing MCP and internal API consumers can migrate without requiring all callers to switch at once.
- NFR-5: The retrieval contract must be explicit enough to support later evaluation of ranking quality, source preference behavior, and context-pack assembly correctness.

## Acceptance Criteria

- [ ] AC-1: A caller can issue one retrieval request and receive ranked candidates from `docs`, `tasks`, and `memories` in a single response.
- [ ] AC-2: The same retrieval request returns both a ranked candidate list and an assembled context pack.
- [ ] AC-3: Every ranked candidate includes source type, source identifier, score, and retrieval method.
- [ ] AC-4: Every context-pack item includes a citation pointing to the originating doc path, task ID, or memory ID.
- [ ] AC-5: With default options, the retrieval response does not include linked items that were only reachable through references.
- [ ] AC-6: With reference expansion explicitly enabled, the retrieval response can include linked `docs`, `tasks`, or `memories`, and each expanded item is marked as expanded rather than a direct hit.
- [ ] AC-7: For a query where a doc, task, and memory all contain overlapping relevant content, the ranked output prefers the doc result ahead of the task and memory results.
- [ ] AC-8: A caller can restrict retrieval to a subset of supported source types and the response excludes disabled source types from both ranked candidates and context pack assembly.
- [ ] AC-9: MCP/agent workflows can consume the retrieval entrypoint without reimplementing source merging or context-pack assembly themselves.
- [ ] AC-10: Internal APIs can consume the same retrieval entrypoint and inspect the ranked candidates independently from the assembled context pack.
- [ ] AC-11: Existing search/indexing infrastructure remains the underlying foundation for supported source retrieval in phase one.

## Scenarios

### Scenario 1: Agent retrieves mixed-source context
**Given** a repository with relevant content in a doc, a task, and a memory entry
**When** an MCP/agent workflow issues a retrieval request for that topic
**Then** the response contains ranked mixed-source candidates
**And** the response also contains an assembled context pack
**And** each returned item is traceable to its original source

### Scenario 2: Internal API inspects ranked results separately from context pack
**Given** an internal API consumer needs retrieval results for debugging or orchestration
**When** it issues a retrieval request
**Then** it can inspect ranked candidates independently of the assembled context pack
**And** it can identify source type, source ID/path, score, and retrieval method for each candidate

### Scenario 3: Default retrieval does not expand references
**Given** a top-ranked doc contains references to a task and a memory
**When** retrieval is executed with default options
**Then** the linked task and memory are not included only because they were referenced
**And** the response contains only direct retrieval hits

### Scenario 4: Caller explicitly enables reference expansion
**Given** a top-ranked doc contains references to related tasks or memories
**When** the caller enables reference expansion for the retrieval request
**Then** linked items may be added to the response
**And** expanded items are marked as expanded context rather than direct hits
**And** callers can still identify which direct match or reference path caused the expansion

### Scenario 5: Docs-first source preference
**Given** a query matches overlapping content in a doc, a task, and a memory
**When** retrieval ranks the results
**Then** the doc is preferred ahead of the task and memory in ranked output
**And** the context pack reflects the same docs-first preference when selecting overlapping evidence

### Scenario 6: Source-restricted retrieval
**Given** a caller wants only doc and task context for a request
**When** the caller disables `memories` in retrieval options
**Then** no memory candidates are returned
**And** the assembled context pack excludes memory-derived context

## Technical Notes

Phase-one implementation should build on the existing Knowns search/indexing foundation and related approved docs rather than replace them.

Related references:
- @doc/specs/semantic-search
- @doc/specs/semantic-search-quality-improvements
- @doc/specs/3-layer-memory-system
- @doc/specs/ast-code-intelligence
- @doc/research/rag-chunking-strategies-research
- @task-szd42a
- @task-prm29p

Expected phase-one architectural direction:
- Reuse existing indexing/chunking for docs, tasks, and memories.
- Add a retrieval-oriented contract on top of current search behavior.
- Keep graph-aware expansion and code context as future follow-up capabilities rather than mandatory phase-one requirements.

## Open Questions

- [ ] Should the docs-first policy affect only ranking order, or also hard-limit how many task/memory items can enter the context pack when docs are present?
- [ ] Should the phase-one retrieval contract expose a caller-controlled context budget, or should budget management remain internal until a later spec?
