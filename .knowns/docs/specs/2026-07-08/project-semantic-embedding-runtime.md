---
title: Project Semantic Embedding Runtime
description: Specification for a shared semantic embedding runtime that centralizes embedding-heavy indexing, search, retrieval, and review workflows to reduce OOM risk across MCP sessions.
createdAt: '2026-07-08T07:02:56.266Z'
updatedAt: '2026-07-08T07:12:32.710Z'
tags:
  - spec
  - approved
  - runtime
  - semantic
  - embedding
  - mcp
  - search
---

## Overview

Introduce a shared semantic embedding runtime for Knowns so embedding-heavy operations do not repeatedly initialize local ONNX, API, or Ollama embedders inside each MCP/CLI/server request. The runtime should centralize semantic indexing, query embedding, retrieval, memory review, and decision review while keeping project and global semantic stores isolated.

The goal is to reduce OOM/process fan-out risk when multiple MCP sessions or UI/server paths use semantic search for the same project, without changing public `search`/`retrieve` contracts beyond additive runtime metadata.

Related context:
- @doc/specs/global-runtime-queue-for-mcp-and-background-work
- @doc/specs/multi-store-semantic-memory-retrieval
- @doc/specs/runtime-process-dashboard
- @doc/specs/2026-07-08/project-lsp-daemon-for-shared-mcp-code-runtime

## Locked Decisions

- D1: Scope is a full semantic runtime: indexing, query embedding, `search`, `retrieve`, `memory review`, and `decision review` all use the shared semantic runtime when semantic behavior is required.
- D2: Use one global runtime process under `~/.knowns/runtime`; job/query state is scoped by project/store root, and embedder/model cache is shared by provider/model/dimensions when safe.
- D3: Runtime failure behavior is mode-specific: `keyword` does not use runtime; `semantic` fails clearly if runtime is unavailable; `hybrid` falls back to keyword with warning/degraded metadata.
- D4: Runtime has configurable idle unload for model/embedder cache; default behavior unloads models after an idle timeout to reduce RAM/OOM risk.
- D5: Status/admin surfaces cover CLI, MCP, API, and WebUI, including model loaded state, provider/model, project consumers, degraded/error state, queue/jobs, idle deadline, and logs.
- D6: Semantic runtime lazy auto-starts by default for every call that needs semantic behavior when semantic search is enabled, but not for keyword mode or disabled semantic config; a config/env kill switch can disable routing for debug/support.
- D7: All embedding providers (`local ONNX`, `api`, and `ollama`) go through semantic runtime for consistent cache, batching, status, degraded behavior, and admin visibility.
- D8: Public `search` and `retrieve` response contracts remain backward compatible; runtime/degraded information is additive only.

## Requirements

### Functional Requirements

- FR-1: All background semantic indexing and reindex jobs for tasks, docs, memories, and decisions must execute through the shared semantic runtime when daemon routing is enabled.
- FR-2: MCP `search` and `retrieve` calls in `semantic` or `hybrid` mode must request query embeddings through the shared runtime instead of initializing embedders inline in each MCP process.
- FR-3: CLI/API/WebUI semantic and hybrid search paths must use the same runtime routing behavior as MCP where semantic search is enabled.
- FR-4: `memory review` and `decision review` semantic similarity paths must use the shared runtime instead of initializing their own embedders inline.
- FR-5: `keyword` mode must not start, require, or call the semantic runtime.
- FR-6: Semantic runtime must preserve project isolation: project store embeddings stay project-scoped, global memory embeddings stay in the global semantic store, and query results must not mix stores except through existing multi-store retrieval merge semantics.
- FR-7: Runtime must maintain an embedder/model cache keyed by provider/model/dimensions and any provider-specific identity required to avoid unsafe reuse.
- FR-8: Runtime must support all configured provider types: local ONNX, OpenAI-compatible API provider, and Ollama.
- FR-9: Runtime must lazy auto-start for semantic-required calls when semantic search is enabled and daemon routing is not disabled.
- FR-10: Runtime must provide a kill switch via env/config that disables semantic runtime routing and makes status report the disabled state explicitly.
- FR-11: Runtime must unload idle model/embedder cache entries after a configurable timeout, with a default timeout chosen to reduce RAM pressure.
- FR-12: Runtime must expose current semantic runtime state through CLI, MCP, API, and WebUI surfaces.
- FR-13: Runtime status must include at least provider, model, loaded/unloaded state, active project/store consumers, queued/running semantic jobs, degraded/error state, idle unload deadline when loaded, and relevant log path.
- FR-14: Runtime logs must make semantic ownership clear enough to distinguish runtime-owned embedding work from inline fallback or disabled routing.
- FR-15: `semantic` mode must return a clear runtime error when semantic runtime is unavailable and no valid semantic result can be produced.
- FR-16: `hybrid` mode must return keyword results with additive warning/degraded metadata when semantic runtime is unavailable, instead of failing the whole request.
- FR-17: Existing successful `search` and `retrieve` response shapes must remain backward compatible; any runtime warning/status fields must be additive.
- FR-18: The runtime must avoid indexing code files with semantic embeddings; code intelligence remains outside this feature and continues to use LSP/BM25 paths.

### Non-Functional Requirements

- NFR-1: Multiple MCP sessions attached to the same project must not each load a separate local embedding model for semantic search/retrieve/review under normal daemon routing.
- NFR-2: Runtime routing must reduce peak memory risk compared with per-request local embedder initialization for concurrent semantic calls.
- NFR-3: Lazy start and idle unload must keep semantic disabled or keyword-only projects lightweight.
- NFR-4: Runtime state files, sockets, and logs must use same-user filesystem protections consistent with existing runtime daemon patterns.
- NFR-5: Runtime errors must be diagnosable from user-facing status surfaces without requiring direct source inspection.
- NFR-6: Public API/MCP compatibility must be maintained for existing clients that ignore additive metadata.

## Acceptance Criteria

- [ ] AC-1: Starting two or more MCP sessions for the same semantic-enabled project and issuing semantic/hybrid `search` calls results in a single shared runtime owner for embedding work, not one loaded local embedder per MCP process.
- [ ] AC-2: `keyword` mode search succeeds without starting the semantic runtime and without loading any embedding provider.
- [ ] AC-3: `semantic` mode returns a clear error when the semantic runtime is disabled or unavailable.
- [ ] AC-4: `hybrid` mode returns keyword results plus additive degraded/warning metadata when the semantic runtime is disabled or unavailable.
- [ ] AC-5: Background task/doc/memory/decision indexing jobs run through runtime-owned semantic execution and show queue/running/recent status in runtime surfaces.
- [ ] AC-6: `memory review` and `decision review` semantic similarity flows use runtime-owned embedding work and do not create independent inline embedders under normal routing.
- [ ] AC-7: Global memory and project semantic indexes remain separate on disk, and multi-store retrieval only merges results at the ranking/response layer.
- [ ] AC-8: Runtime status in CLI, MCP, API, and WebUI shows provider/model, loaded state, project consumers, queued/running jobs, degraded errors, idle unload deadline, and log path.
- [ ] AC-9: Idle model unload can be observed: after the configured timeout with no semantic work, runtime status changes from loaded to unloaded and memory-heavy provider resources are closed.
- [ ] AC-10: All provider types covered by existing config paths (`local ONNX`, `api`, `ollama`) route through the runtime and report consistent status/degraded behavior.
- [ ] AC-11: Existing clients that parse current `search` and `retrieve` success responses continue to work when new runtime metadata fields are present.
- [ ] AC-12: A smoke test with concurrent MCP semantic calls demonstrates no duplicate per-MCP local model loading in normal runtime mode.

## Scenarios

### Scenario 1: Concurrent MCP semantic search
**Given** a project has semantic search enabled and a local ONNX model installed
**And** two MCP stdio sessions are connected to the same project
**When** both sessions call `search` in `semantic` or `hybrid` mode
**Then** the calls route through the shared semantic runtime
**And** runtime status shows one shared model cache entry rather than one embedder per MCP process.

### Scenario 2: Keyword-only search stays lightweight
**Given** a project has semantic search enabled
**When** a caller runs `search` with `mode=keyword`
**Then** the semantic runtime is not started for that request
**And** keyword results are returned using the lexical path only.

### Scenario 3: Semantic runtime unavailable in semantic mode
**Given** semantic runtime routing is enabled
**And** the runtime cannot start or cannot load the configured provider
**When** a caller runs `search` with `mode=semantic`
**Then** the request fails with a clear runtime error
**And** the error points to status/log guidance.

### Scenario 4: Semantic runtime unavailable in hybrid mode
**Given** semantic runtime routing is enabled
**And** the runtime cannot start or cannot load the configured provider
**When** a caller runs `search` with `mode=hybrid`
**Then** keyword results are returned
**And** the response includes additive degraded/warning metadata explaining that semantic ranking was skipped.

### Scenario 5: Runtime-owned indexing
**Given** a task, doc, memory, or decision changes
**When** background indexing is requested
**Then** the job is queued for runtime-owned semantic execution
**And** `runtime ps/status` surfaces show queued/running/recent semantic job state.

### Scenario 6: Idle unload
**Given** the semantic runtime has loaded a model for recent semantic work
**When** no semantic jobs or queries use that model until the configured idle timeout expires
**Then** the runtime closes the cached provider/model resources
**And** status reports the model as unloaded while the daemon may remain alive for other runtime duties.

### Scenario 7: Multi-store memory retrieval
**Given** project memory and global memory semantic stores both exist
**When** a caller runs memory retrieval in semantic or hybrid mode
**Then** runtime-owned query embedding is used
**And** project/global stores remain physically separate while results are merged through existing retrieval ranking semantics.

## Technical Notes

- Current `internal/runtimequeue` already provides a global runtime daemon and project-scoped queues; this feature should build on that foundation instead of creating a separate daemon family for task/doc/memory CRUD.
- Current inline semantic initialization appears in MCP/CLI search, memory review, decision review, and runtime job execution. This spec requires replacing normal semantic paths with runtime-owned execution while keeping keyword paths inline.
- Runtime cache keys must include enough provider identity to avoid cross-provider or cross-model contamination. For API providers this includes provider/model/dimensions and endpoint identity; for local ONNX this includes model directory/model ID/dimensions.
- Model cache lifetime is separate from daemon lifetime. A daemon can remain running while its semantic model cache is unloaded.
- This feature must not reintroduce semantic code-file indexing. Code search/intelligence remains separate from default semantic knowledge indexing.

## Task Links

- @task-rjrhc4 [project-semantic-embedding-runtime-01] Add semantic runtime foundation and model cache — todo
- @task-gev8n1 [project-semantic-embedding-runtime-02] Move semantic indexing and reindex execution into runtime — todo
- @task-0jd053 [project-semantic-embedding-runtime-03] Route search and retrieve semantic paths through runtime — todo
- @task-jhaa65 [project-semantic-embedding-runtime-04] Route memory and decision review through runtime — todo
- @task-hj5e1a [project-semantic-embedding-runtime-05] Expose semantic runtime status and admin surfaces — todo
- @task-xg4jxl [project-semantic-embedding-runtime-06] Add runtime smoke and compatibility verification — todo

## Open Questions

None.
