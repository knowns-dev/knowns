---
title: Task Lifecycle Context Hygiene
description: Specification for lifecycle-aware Task retrieval, delayed archival, reversible reopening, consistent surfaces, and auditable deletion.
createdAt: '2026-07-21T09:36:31.494Z'
updatedAt: '2026-07-22T05:17:49.453Z'
tags:
  - spec
  - approved
  - tasks
  - retrieval
  - lifecycle
  - sdd
---

## Overview

Define a lifecycle for Knowns Tasks that prevents completed work and its implementation Plan from polluting default AI context while preserving a complete, inspectable audit trail. A Task becomes historical in two stages: it leaves default AI retrieval immediately when marked `done`, then moves to archive after a configurable delay. Human search remains able to find completed work, and historical AI retrieval is explicit.

This feature manages the whole Task. The implementation Plan remains part of the Task and does not become a separate entity. Specifications remain living documents; archiving a Task must not archive or delete its linked Spec.

Related context:
- @doc/specs/sdd-spec-driven-development
- @doc/specs/rag-retrieval-foundation
- @doc/specs/2026-06-18/memory-decision-review-ui
- @doc/specs/2026-06-26/doc-history-revision-log-and-webui
- @doc/guides/workflow-guide

## Locked Decisions

- D1: A Task marked `done` is excluded from default AI retrieval immediately. Eligible Tasks are automatically archived 30 days after entering `done`. Archived Tasks are not automatically purged.
- D2: Auto-archive applies only when the Task is `done`, has no active timer, and every descendant Task is either `done` or archived. Reopening a completed or archived Task automatically cancels pending archival or unarchives it, restores it to active storage and retrieval, and preserves its history.
- D3: Human search continues to return `done` Tasks. Default AI retrieval returns active Tasks only. `includeHistorical=true` includes `done` and archived Tasks, ordered by lifecycle group `active → done → archived` and then by relevance within each group. Every result exposes lifecycle metadata.
- D4: CLI, MCP, API, and WebUI expose consistent archive, unarchive, and batch-archive behavior. Project configuration is canonical; global settings only seed defaults when a project is initialized. Batch archive is preview-only by default and requires explicit confirmation or an equivalent execution signal.
- D5: Archive preserves the complete Task, Plan, Notes, references, and version history. Hard-delete is a separate operation that removes content and history but leaves a minimal tombstone containing Task ID, timestamp, actor, and reason. Archive warns about potentially uncaptured durable knowledge without blocking; linked Docs, Decisions, and Memories are retained as archive metadata.

## Requirements

### Functional Requirements

- FR-1: The project configuration must support Task lifecycle settings equivalent to:
  - `excludeDoneFromDefaultRetrieval: true`
  - `autoArchive: true`
  - `archiveAfter: "30d"`
  - `purgeAfter: null`
- FR-2: Built-in defaults must match D1 when a project does not override the lifecycle settings.
- FR-3: Global settings may seed lifecycle defaults during project initialization, but changing global settings must not silently alter an existing project's canonical lifecycle configuration.
- FR-4: Transitioning a Task to `done` must record enough lifecycle timing metadata to calculate the archive deadline from the transition time.
- FR-5: A `done` Task must stop appearing in default AI retrieval/context after the status transition is persisted and indexed.
- FR-6: Human-oriented search must continue to return matching `done` Tasks and clearly identify their lifecycle state.
- FR-7: Default AI retrieval must exclude both `done` and archived Tasks.
- FR-8: AI retrieval with `includeHistorical=true` must include active, `done`, and archived Tasks; group ordering must be active before `done` before archived, with relevance ordering applied within each group.
- FR-9: Search and retrieval results for Tasks must expose whether the Task is active, `done`, or archived, plus relevant completion/archive timestamps when available.
- FR-10: Auto-archive must archive only a Task that is `done`, has no active timer, and has no descendant outside `done` or archived state.
- FR-11: A Task that is ineligible at its archive deadline must remain unarchived and expose the blocking reason; it must become eligible without losing the original completion history after all blockers are resolved.
- FR-12: Reopening a `done` Task before archival must cancel its pending archive eligibility and restore it to default AI retrieval.
- FR-13: Reopening an archived Task must atomically restore it to active Task storage, reindex its current content, preserve version history and references, and expose the updated lifecycle state.
- FR-14: Archiving or reopening a parent must not recursively mutate descendants. Parent eligibility is determined from descendant state.
- FR-15: Manual archive, unarchive, and batch archive must be available with equivalent behavior through CLI, MCP, API, and WebUI.
- FR-16: Batch archive must produce a preview by default containing eligible Tasks, skipped Tasks, and a machine-readable reason for every skip.
- FR-17: Batch archive mutation must require explicit confirmation, `--yes`, `dryRun=false`, or an equivalent unambiguous execution signal appropriate to the surface.
- FR-18: Archive must preserve the Task body, Implementation Plan, Implementation Notes, acceptance criteria, Spec and semantic references, timestamps, time entries, and Task version history.
- FR-19: Archived Tasks must remain directly readable by Task ID and discoverable through explicit historical search or retrieval.
- FR-20: Archiving a Task must not change the lifecycle, content, or location of its linked Spec.
- FR-21: Before an archive mutation, the system must evaluate whether the Task appears to contain uncaptured durable knowledge and may return a warning, but the warning must not block explicit or automatic archival.
- FR-22: References to extracted Docs, Decisions, or Memories must remain attached to the archived Task as lifecycle/audit metadata.
- FR-23: Hard-delete must be a separately authorized action from archive and must require a reason plus explicit confirmation.
- FR-24: Hard-delete must remove the Task content, Task version history, and searchable/indexed representations, while retaining a tombstone with Task ID, deletion timestamp, actor when known, and reason.
- FR-25: Tombstones must not expose deleted Task content and must prevent a deleted Task ID from being silently reused.
- FR-26: Existing active and archived Task files must remain readable. Existing archived Tasks must be treated as historical without requiring destructive migration.
- FR-27: Existing callers that omit lifecycle options must retain human search compatibility while adopting the new default AI retrieval filtering.
- FR-28: Archive, unarchive, auto-archive, batch archive, and hard-delete operations must emit consistent audit metadata and lifecycle events across supported surfaces.

### Non-Functional Requirements

- NFR-1: Lifecycle transitions and search-index updates must be idempotent and recoverable after interruption.
- NFR-2: A failed index update must be detectable and repairable by reindexing without losing canonical Task data.
- NFR-3: Concurrent archive, reopen, status update, or delete requests must not leave duplicate active/archive copies or conflicting lifecycle states.
- NFR-4: Machine-readable CLI, MCP, and API responses must use consistent lifecycle field names and skip/error reason codes.
- NFR-5: Default retrieval must not return historical Task content through semantic, lexical, hybrid, graph-expansion, or context-pack paths.
- NFR-6: Lifecycle filtering must be enforced centrally enough that new retrieval consumers do not accidentally bypass it.
- NFR-7: Destructive deletion must be permission-gated and auditable without retaining deleted content.
- NFR-8: Lifecycle configuration must validate durations, reject negative values, and distinguish disabled archival from zero-delay archival.

## Acceptance Criteria

- [x] AC-1: Marking an indexed active Task as `done` removes it from default AI retrieval while the same Task remains visible in human search with lifecycle state `done`.
- [x] AC-2: A Task is automatically archived only after 30 days from its `done` transition under default configuration.
- [x] AC-3: A `done` Task with an active timer or any non-terminal descendant is skipped by auto-archive with a stable machine-readable reason.
- [x] AC-4: Reopening a `done` Task before archival restores it to default AI retrieval and invalidates the pending archive deadline.
- [x] AC-5: Reopening an archived Task restores a single active copy, reindexes it, and preserves its Plan, Notes, references, and version history.
- [x] AC-6: Default AI retrieval returns no `done` or archived Tasks across keyword, semantic, hybrid, and structured context-pack paths.
- [x] AC-7: With `includeHistorical=true`, matching results are grouped active before `done` before archived and contain explicit lifecycle metadata.
- [x] AC-8: Human search continues to return matching active and `done` Tasks without requiring `includeHistorical`; archived Tasks require historical opt-in or direct lookup.
- [x] AC-9: CLI, MCP, API, and WebUI can preview and execute archive, unarchive, and batch archive with equivalent eligibility and reason semantics.
- [x] AC-10: A batch archive request without explicit execution intent makes no mutation and returns eligible and skipped Task lists.
- [x] AC-11: Archiving a Task preserves its full content and history and does not modify its linked Spec.
- [x] AC-12: An archive warning about uncaptured durable knowledge is observable but does not block an otherwise valid archive.
- [x] AC-13: Hard-delete requires explicit confirmation and a reason, removes content/history/index data, leaves a content-free tombstone, and prevents Task ID reuse.
- [x] AC-14: Existing Task and archive data load successfully after upgrade, and a full reindex does not reintroduce archived Tasks into default AI retrieval.
- [x] AC-15: Automated tests cover lifecycle transitions, eligibility blockers, retrieval modes, ranking groups, all public surfaces, interrupted index updates, concurrent operations, and backward compatibility.

## Scenarios

### Scenario 1: Completed Task leaves AI context before archive

**Given** an active indexed Task and the default lifecycle configuration  
**When** the Task transitions to `done`  
**Then** human search can still find it, default AI retrieval cannot return it, and its archive eligibility date is 30 days after completion.

### Scenario 2: Parent is blocked by an unfinished descendant

**Given** a `done` parent whose archive deadline has passed and one descendant remains `in-progress`  
**When** auto-archive evaluates the parent  
**Then** the parent remains in active storage, remains excluded from default AI retrieval, and reports a descendant-state blocker.

### Scenario 3: Completed Task is reopened during the delay

**Given** a `done` Task scheduled for later archive  
**When** its status changes to a non-`done` state  
**Then** pending archive eligibility is canceled and the Task returns to default AI retrieval.

### Scenario 4: Archived Task is reopened

**Given** an archived Task with Plan, Notes, references, and version history  
**When** a caller reopens it through any supported surface  
**Then** it returns to active storage and the index exactly once, with its historical data intact.

### Scenario 5: Historical retrieval is explicit

**Given** matching active, `done`, and archived Tasks  
**When** AI retrieval runs without historical opt-in  
**Then** only the active Task is returned.  
**When** it runs with `includeHistorical=true`  
**Then** all matching lifecycle groups may be returned in active, `done`, archived order with explicit state metadata.

### Scenario 6: Batch archive preview and execution

**Given** a mixture of eligible and blocked completed Tasks  
**When** a batch archive request is made without execution confirmation  
**Then** no files or indexes change and the response previews eligible Tasks and skip reasons.  
**When** the caller explicitly confirms execution  
**Then** only eligible Tasks are archived and the result reports every mutation and skip.

### Scenario 7: Durable knowledge warning

**Given** an eligible Task containing implementation guidance that is not linked to a Doc, Decision, or Memory  
**When** archive is requested  
**Then** the caller receives a non-blocking warning and may proceed with the archive.

### Scenario 8: Hard-delete with tombstone

**Given** an archived Task that must be removed for a permitted reason  
**When** an authorized caller confirms hard-delete and supplies the reason  
**Then** Task content, history, and index entries are removed; a content-free tombstone records identity and audit metadata; the ID cannot be reused.

### Scenario 9: Existing repository upgrade

**Given** a repository containing existing active and archived Task files  
**When** the new lifecycle behavior is enabled and the project is reindexed  
**Then** all existing Tasks remain readable, default AI retrieval excludes historical Tasks, and no destructive migration occurs.

## Technical Notes

- Reuse the existing Task archive/unarchive storage behavior, Task version history, search indexing hooks, and batch archive route where their behavior satisfies this spec.
- Follow the trusted-default retrieval pattern already used for Memory and Decision lifecycle filtering.
- Treat Task files and version history as canonical; search indexes are derived and repairable.
- The planning phase should identify one shared lifecycle eligibility and visibility policy used by CLI, MCP, API, WebUI, search, retrieve, graph expansion, and context-pack assembly.
- The planning phase should define stable response fields and reason codes rather than allowing each surface to invent them independently.
- Context compression is complementary and must not be used as a substitute for lifecycle-aware retrieval filtering.

## Task Links

- @task-vr4vz2 — `[task-lifecycle-context-hygiene-01]` Task lifecycle metadata and project defaults
- @task-d8sxrv — `[task-lifecycle-context-hygiene-02]` Archive, reopen, delete, and auto-archive transitions
- @task-9jb2yo — `[task-lifecycle-context-hygiene-03]` Lifecycle-aware Task search and retrieval
- @task-melsmw — `[task-lifecycle-context-hygiene-04]` CLI, MCP, and API lifecycle operations
- @task-vxccet — `[task-lifecycle-context-hygiene-05]` WebUI lifecycle settings and archive workflows
- @task-32xjeo — `[task-lifecycle-context-hygiene-06]` Migration and end-to-end lifecycle verification

## Open Questions

None. The product and lifecycle decisions required for task planning are locked above.
