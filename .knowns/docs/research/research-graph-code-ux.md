---
id: doc-5c489bbb209e8bf6e3571a68312204fd
title: 'Research: Graph Code UX'
description: Research and recommendations for keeping a single GraphPage while making code graphs easier to use and less overwhelming.
createdAt: '2026-04-06T04:39:19.404Z'
updatedAt: '2026-04-06T04:40:20.505Z'
tags:
  - research
  - graph
  - code
  - webui
  - ux
---

## Summary

Keep a single GraphPage and improve the UX with same-page presets rather than splitting Graph Doc and Graph Code into separate pages immediately.

Recommended first pass:
- add a Knowledge preset for task/doc/memory exploration
- add a Code preset for code-aware exploration on the same page
- keep code hidden by default
- when Code mode is enabled, reduce noise by showing only the least noisy code relationships by default

## Why this direction

The current graph model already mixes knowledge nodes and code nodes intentionally:
- @doc/specs/ast-code-intelligence defines `GET /api/graph?includeCode=true` as the way to add code nodes and code edges to the existing graph.
- Docs/tasks can connect to code via `code-ref`, so separating the pages too early would make those cross-entity relationships harder to inspect.

The current backend is also all-or-nothing for code graph data, so a split page would not automatically solve the noise problem by itself.

## Existing docs and decisions

### Existing references
- @doc/specs/ast-code-intelligence — spec for code indexing, `includeCode`, and graph integration
- @doc/learnings/learning-knowledge-graph-webui — Cytoscape patterns and graph UI decisions
- @doc/specs/graph-intelligence-features — graph-side search, impact, and cluster behaviors

### Relevant prior decisions
- Keep graph as a read-only exploration view.
- Hide isolated nodes by default to reduce clutter.
- Reuse client-side Cytoscape traversal APIs for graph intelligence before adding backend complexity.

## Current implementation surface

### Frontend
- `ui/src/pages/GraphPage.tsx`
  - already has node and edge filters for tasks, docs, memories, code, `code-ref`, `calls`, `imports`, and `contains`
  - already fetches `/api/graph?includeCode=true` when code is enabled
  - already has reusable search, impact, cluster, and dimming behaviors for local focus
- `ui/src/pages/GraphDetailPanel.tsx`
  - currently supports task/doc details well
  - currently provides very little code-node-specific detail
- `ui/src/api/client.ts`
  - current client graph types lag behind actual runtime graph behavior and should be kept in sync

### Backend
- `internal/server/routes/graph.go`
  - `GET /api/graph` returns task/doc/memory graph by default
  - `GET /api/graph?includeCode=true` appends all indexed code nodes and code edges
  - current code behavior is all-or-nothing; there is no scoped subgraph API yet

## Research findings

### What is reusable now
- Existing filter state in GraphPage is already sufficient to implement Knowledge and Code presets without a redesign.
- Existing search, impact, and cluster logic can continue to work on top of those presets.
- Existing `showIsolated=false` behavior is already one of the strongest anti-noise controls for large graphs.

### What is missing or inconsistent now
- There is no explicit same-page Knowledge vs Code preset control yet.
- SSE refresh currently risks dropping code mode because reload paths do not consistently preserve the active code state.
- `contains` exists in graph state/style but is not fully exposed in the toolbar/legend.
- Code nodes are visually present but not fully supported in the detail panel.
- Frontend type unions need to match current graph node/edge types.
- Docs and code currently disagree on one implementation detail: the learning doc says built-in `cose` was preferred over `fcose`, but the current graph page still imports and uses `fcose`.

## Recommended UX model

### 1. Keep one graph page
Use one page with lightweight presets instead of splitting immediately.

### 2. Add two same-page presets
#### Knowledge preset
Default exploration mode for task/doc/memory work.

Suggested defaults:
- tasks: on
- docs: on
- memories: on
- code: off
- isolated: off
- edges: parent/spec/mention on
- code edges: off

#### Code preset
Code-aware mode for inspecting knowledge-linked code without flooding the view.

Suggested defaults:
- tasks: on
- docs: on
- memories: optional off
- code: on
- isolated: off
- `code-ref`: on
- `calls`: off by default
- `imports`: off by default
- `contains`: off by default

This makes the first Code view focus on knowledge-connected code rather than the full structural code graph.

### 3. Treat structural code edges as progressive reveal
Do not turn on all code edges by default.

Recommended reveal order:
1. `code-ref`
2. `calls`
3. `imports`
4. `contains`

This preserves context while avoiding immediate graph explosion.

## Constraints and tradeoffs

### First-pass constraint
A frontend-only first pass is enough to improve visible clutter and mode clarity.

### Tradeoff
Because the backend currently returns all code nodes when `includeCode=true`, the first pass improves visible clutter more than payload size or layout cost.

### When backend work becomes necessary
If large repositories still feel slow or noisy after presets + default filters are added, the next step should be a backend-focused code subgraph API rather than a second page.

Potential second-pass backend directions:
- scope code graph by file path or symbol
- scope code graph to knowledge-linked code only
- return a bounded 1-hop or 2-hop code neighborhood

## Recommended implementation order

1. Add same-page Knowledge and Code presets in GraphPage.
2. Preserve the active code state on graph reload/SSE refresh.
3. Expose `contains` in the toolbar and legend.
4. Improve code-node detail rendering in GraphDetailPanel.
5. Sync client graph types with actual runtime graph node/edge types.
6. Reassess whether backend graph scoping is still needed after the UX pass.

## Follow-up note

If this research turns into implementation work, reference this doc from the task or plan as:
- @doc/research/research-graph-code-ux
