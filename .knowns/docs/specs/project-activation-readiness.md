---
id: doc-81c035e0fc96dfa7071f07336415a49e
title: Project Activation Readiness
description: Specification for a unified project activation and readiness model across CLI, browser, runtime, and AI clients.
createdAt: '2026-04-22T08:51:27.505Z'
updatedAt: '2026-04-23T03:55:36.714Z'
tags:
  - spec
  - approved
  - status
  - runtime
  - ui
  - mcp
  - setup
---

# Project Activation Readiness

## Overview

Define a unified readiness model for Knowns projects so both humans and AI clients can immediately understand whether a project is active, what knowledge is available, which runtimes are connected, and what the system can do right now.

This consolidates activation state currently spread across init, sync, browser status, runtime status, and import state into one canonical payload exposed via CLI, server API, and MCP.

Related: @doc/research/project-activation-readiness

## Locked Decisions

- D1: Readiness payload covers project + global + connected runtimes.
- D2: Expose via `knowns status` (CLI), mở rộng `GET /api/status` (server), MCP tool `status` mới. Cùng payload, khác presentation.
- D3: Hybrid compute — entity counts + search status real-time, runtime health dùng cached snapshot từ server polling (CLI fallback probe trực tiếp).
- D4: Backward compatible — giữ nguyên fields cũ (`active`, `projectName`, `projectPath`), thêm fields mới. Frontend migrate dần.

## Problem

Knowns already has solid setup primitives (`knowns init`, `knowns sync`, runtime queue, adapter install). However, activation state is fragmented across multiple commands, outputs, and UI surfaces.

A user should not need to infer readiness by combining init output, sync output, search index status, runtime process status, active project status, import state, and client connection status separately.

Existing endpoints:
- `GET /api/status` returns only `{ active, projectName, projectPath }`
- `GET /api/opencode/status` returns `RuntimeStatus` separately
- MCP `get_current_project` returns only project path
- No CLI command aggregates all readiness signals

## Goals

- Make project activation explicit and inspectable from one surface.
- Provide a single readiness summary for CLI, MCP, and browser.
- Show what knowledge is active and what actions are currently available.
- Make failures and partial readiness states obvious instead of implicit.

## Non-Goals

- Replace existing init or sync commands.
- Couple readiness to one AI client or one runtime vendor.
- Require semantic indexing for minimal project activation.
- Break existing frontend consumers of `GET /api/status`.

## Requirements

### Functional Requirements

- FR-1: Knowns must expose a unified readiness payload for the active project.
- FR-2: Readiness must include project identity (name, path, active flag) and Knowns version.
- FR-3: Readiness must report knowledge counts — docs, tasks, templates, memories (by layer: project + global), and relation count when available.
- FR-4: Readiness must report search status — semantic enabled, model installed, project index ready, global index ready, index freshness timestamp.
- FR-5: Readiness must report runtime status — enabled, running, connected clients, queued/running jobs. Use cached snapshot from server polling loop; CLI probes directly as fallback.
- FR-6: Readiness must report import summary — count of active import sources.
- FR-7: Readiness must include a capability summary — list of what the AI can do right now (search, task/doc updates, memory tools, template generation, graph features, browser chat).
- FR-8: `GET /api/status` must remain backward compatible — keep existing `active`, `projectName`, `projectPath` fields, add new readiness fields alongside.
- FR-9: CLI `knowns status` command must render the same readiness payload in human-friendly format. Support `--plain` and `--json` flags.
- FR-10: MCP tool `status` must return the structured readiness payload for AI clients.
- FR-11: Entity counts and search status must be computed real-time per request. Runtime health must use cached snapshot (D3).

### Non-Functional Requirements

- NFR-1: Readiness response must complete within 200ms for server/MCP (cached runtime). CLI may take longer due to direct probe.
- NFR-2: Partial readiness must be represented explicitly — not collapsed into binary ready/not-ready.
- NFR-3: The readiness model must remain client-neutral and reusable by future runtimes.

## Readiness Payload Model

```json
{
  "active": true,
  "projectName": "my-project",
  "projectPath": "/path/to/project",
  "version": "0.42.0",

  "knowledge": {
    "docs": 42,
    "tasks": 27,
    "templates": 6,
    "memories": {
      "project": 15,
      "global": 8
    },
    "relations": 184,
    "imports": 3
  },

  "search": {
    "semanticEnabled": true,
    "modelConfigured": true,
    "modelInstalled": true,
    "projectIndexReady": true,
    "globalIndexReady": true,
    "lastReindex": "2026-04-23T10:30:00Z"
  },

  "runtime": {
    "enabled": true,
    "running": true,
    "connectedClients": 2,
    "queuedJobs": 1,
    "runningJobs": 0,
    "state": "healthy"
  },

  "capabilities": [
    "search",
    "semantic-search",
    "task-updates",
    "doc-updates",
    "memory-tools",
    "template-generation",
    "graph",
    "browser-chat"
  ]
}
```

Fields `active`, `projectName`, `projectPath` are preserved for backward compatibility (D4).

## Scenarios

### Scenario 1: Fully Ready Project
**Given** a project with docs, tasks, semantic model installed, runtime running
**When** user runs `knowns status` or AI calls MCP `status`
**Then** readiness shows all sections green with full capability list

### Scenario 2: Project Without Semantic Model
**Given** a project initialized but semantic model not downloaded
**When** user checks readiness
**Then** search section shows `modelInstalled: false`, capabilities omit `semantic-search`, other sections normal

### Scenario 3: No Active Project (Browser)
**Given** browser opened without active project
**When** `GET /api/status` called
**Then** `active: false`, knowledge/search/runtime sections omitted or zeroed, capabilities empty

### Scenario 4: Runtime Degraded
**Given** OpenCode daemon crashed but project data intact
**When** readiness checked
**Then** runtime shows `state: "degraded"`, capabilities omit `browser-chat`, rest normal

### Scenario 5: CLI Without Server
**Given** user runs `knowns status` without browser server running
**When** CLI computes readiness
**Then** entity counts and search status computed directly from disk, runtime section shows `enabled: false` or probes daemon directly (D3 fallback)

## API Direction

### CLI

```bash
knowns status              # Human-friendly readiness summary
knowns status --plain      # Plain text for piping
knowns status --json       # Structured JSON payload
```

Example human-friendly output:

```text
Project: my-project (ready)
Knowledge: 42 docs, 27 tasks, 6 templates, 23 memories, 184 relations
Imports: 3 active sources
Search: semantic ready, indices fresh (10m ago)
Runtime: healthy, 2 clients, 1 queued job
Capabilities: search, task/doc updates, memory, templates, graph, chat
```

### Server

`GET /api/status` — returns full readiness payload (backward compatible, adds new fields).

### MCP

New tool `status` — returns same structured payload as JSON.

## Implementation Direction

1. Define `ReadinessPayload` struct in `internal/models/` or `internal/readiness/`.
2. Create `BuildReadiness(store, runtimeSnapshot)` function that collects all sections.
3. Entity counts: `store.Docs.Count()`, `store.Tasks.Count()`, etc. — real-time from disk.
4. Search status: check `store.Config` for semantic settings + stat index files.
5. Runtime: accept cached `RuntimeStatus` snapshot from server; CLI builds its own via direct probe.
6. Capabilities: derive from search + runtime + config state.
7. Wire into `handleStatus` (server), new CLI command, new MCP tool.

## Rollout Plan

### Phase 1
- Define `ReadinessPayload` model.
- Implement `BuildReadiness()` core function.
- Add `knowns status` CLI command with `--plain` and `--json`.
- Extend `GET /api/status` with new fields (backward compatible).
- Add MCP `status` tool.

### Phase 2
- Add readiness card/panel in browser UI.
- Add import source details.
- Add relation counts from graph metadata.

### Phase 3
- Add freshness metadata and degraded-state explanations.
- Connect capability gating with permission model (when available).
- Add historical readiness snapshots for debugging.

## Acceptance Criteria

- [ ] AC-1: `knowns status` CLI command returns human-readable readiness summary.
- [ ] AC-2: `knowns status --json` returns structured readiness payload with all sections (knowledge, search, runtime, capabilities).
- [ ] AC-3: `GET /api/status` returns existing fields (`active`, `projectName`, `projectPath`) plus new readiness fields — no breaking change.
- [ ] AC-4: MCP tool `status` returns the same structured payload as `--json`.
- [ ] AC-5: Partial failures (missing model, stale index, degraded runtime) are shown explicitly, not collapsed into binary state.
- [ ] AC-6: Entity counts are computed real-time; runtime health uses cached snapshot from server polling (CLI probes directly as fallback).
- [ ] AC-7: Capability summary reflects actual system state — omits capabilities when dependencies are unavailable.

## Open Questions

- Should readiness counts include archived tasks or only active tasks?
- Should relation counts include code graph edges, knowledge graph edges, or both?
- Should connected AI clients be inferred from runtime leases only, or tracked as richer client sessions?
- Should `knowns status` warn when skills are out of sync (like existing `maybeWarnSkillsOutOfSync`)?
