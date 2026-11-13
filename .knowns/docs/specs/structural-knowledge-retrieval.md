---
id: doc-b77ee4ea5b8e1a016315ab6adf2a0c61
title: Structural Knowledge Retrieval
description: Draft specification for relation-aware structural retrieval across Knowns entities and graph edges.
createdAt: '2026-04-22T08:51:27.393Z'
updatedAt: '2026-04-23T08:24:32.606Z'
tags:
  - spec
  - approved
---

# Structural Knowledge Retrieval

## Overview

Define a structural retrieval layer for Knowns that goes beyond semantic ranking and keyword search by using typed entities, explicit relations, and traversable graph edges across docs, tasks, memories, templates, and code.

This work builds on the current retrieval and semantic reference foundations from @doc/specs/rag-retrieval-foundation and @doc/specs/semantic-reference-runtime.

## Locked Decisions

- D1: Structural retrieval extends the existing `resolve` action in the `search` tool — adds params for traversal direction, depth, and filters. No new tool or action.
- D2: Relation source priority: field-backed > inline refs > code-graph edges. Deduplicate by (source, target, relation), preserve origin metadata on each edge.
- D3: Full relation allowlist from day one. Max traversal depth = 3. Multi-hop supported immediately.
- D4: Keep current identity model — path-based for docs, short ID for tasks/memories. No dependency on stable entity IDs. Doc rename rewrites edges per @doc/specs/semantic-reference-runtime.

## Problem

Knowns can already:

- parse relation-aware inline references such as `@doc/...{implements}` and `@task-...{blocked-by}`
- resolve references into structured entities
- expose graph views and typed code edges
- expand references during retrieval

But retrieval is still mostly query-first instead of relation-first. The system does not yet support first-class structural questions such as:

- which tasks implement a given doc
- which tasks are blocked by another task
- which docs depend on a given doc
- which templates fit a project stack or feature type
- which acceptance criteria connect to which implementation plan items

## Goals

- Add first-class structural retrieval over Knowns entities and relations.
- Support relation traversal as a retrieval primitive, not just a rendering detail.
- Make entity-to-entity structure reusable across CLI, MCP, WebUI, and future automation.
- Preserve compatibility with existing semantic search and inline reference syntax.

## Non-Goals

- Replace semantic search or keyword search.
- Require all relations to be manually authored inline.
- Introduce a heavy graph query language.
- Block on stable entity IDs — use current path/ID model.

## Requirements

### Functional Requirements

- FR-1: The `resolve` action in the `search` MCP tool must accept optional structural traversal params: `direction` (outbound | inbound | both), `depth` (1–3, default 1), `relationTypes` (filter by relation kind), and `entityTypes` (filter by entity kind).
- FR-2: When structural params are present, `resolve` must return typed relation edges with source entity, target entity, relation kind, direction, traversal depth, and origin metadata (field-backed | inline | code-graph).
- FR-3: The system must support the full relation allowlist: `implements`, `depends`, `blocked-by`, `follows`, `references`, `related`, `parent`, `spec`, `imported-from`, `template-for`.
- FR-4: Relation edges must be merged from multiple sources with priority: field-backed first, inline refs second, code-graph edges third. Deduplication by (source, target, relation) tuple.
- FR-5: Multi-hop traversal up to depth 3 must be supported, returning the full traversal path for each result edge.
- FR-6: CLI `knowns resolve` must expose the same structural params as the MCP tool: `--direction`, `--depth`, `--relation`, `--type`.
- FR-7: Structural retrieval results must include unresolved edges (target not found) with a clear marker so consumers can handle gracefully.
- FR-8: WebUI must be able to render structural retrieval results as relation-aware lists and optionally as graph views.
- FR-9: Entity identity uses path-based for docs, short ID for tasks/memories. Doc rename triggers edge rewrite per @doc/specs/semantic-reference-runtime.

### Non-Functional Requirements

- NFR-1: Structural retrieval must degrade gracefully when some relations are missing or unresolved — return partial results, never error.
- NFR-2: Traversal results must be deterministic for the same store state and query.
- NFR-3: Depth-3 traversal on a project with up to 500 entities must complete within 500ms.
- NFR-4: The implementation must remain compatible with @doc/specs/semantic-reference-runtime and existing retrieval contracts from @doc/specs/rag-retrieval-foundation.
- NFR-5: Each edge in the result must carry origin metadata so consumers can distinguish field-backed from inline from code-graph sources.

## Entity Kinds

- doc
- task
- memory
- template
- code

Future (out of scope for this spec):
- task-ac (acceptance criteria sub-entity)
- task-plan-item (plan item sub-entity)

## Relation Kinds (Full Allowlist)

| Relation | Typical source → target | Origin |
|----------|------------------------|--------|
| `implements` | task/doc → doc | inline ref |
| `depends` | doc/task → doc/task | inline ref |
| `blocked-by` | task → task | inline ref |
| `follows` | doc/task → doc/task | inline ref |
| `references` | any → any | inline ref |
| `related` | any → any | inline ref |
| `parent` | task → task | field-backed |
| `spec` | task → doc | field-backed |
| `imported-from` | code → code | code-graph |
| `template-for` | template → doc/task | derived |

## API Surface

### MCP — Extended `resolve` action

Existing `search({ action: "resolve" })` gains new optional params:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `ref` | string | (required) | Semantic reference expression, e.g. `@doc/specs/auth{implements}` |
| `direction` | `"outbound"` \| `"inbound"` \| `"both"` | `"outbound"` | Traversal direction from root entity |
| `depth` | number (1–3) | 1 | Max traversal hops |
| `relationTypes` | string (comma-separated) | all | Filter by relation kinds |
| `entityTypes` | string (comma-separated) | all | Filter result entities by kind |

Response shape additions:

```json
{
  "root": { "kind": "doc", "id": "specs/auth", "title": "Auth Spec" },
  "edges": [
    {
      "source": { "kind": "doc", "id": "specs/auth" },
      "target": { "kind": "task", "id": "abc123", "title": "Implement auth" },
      "relation": "implements",
      "direction": "inbound",
      "depth": 1,
      "origin": "field-backed",
      "resolved": true
    }
  ],
  "unresolved": [
    {
      "ref": "@task-xyz{blocked-by}",
      "reason": "entity not found"
    }
  ]
}
```

### CLI — Extended `knowns resolve`

```bash
knowns resolve '@doc/specs/auth{implements}'
knowns resolve '@doc/specs/auth{implements}' --direction inbound
knowns resolve '@doc/specs/auth{depends}' --depth 2 --type doc
knowns resolve '@task-abc{blocked-by}' --direction both --relation blocked-by,depends
knowns resolve '@doc/api{depends}' --depth 3 --type doc,task --plain
```

## Data Strategy

Structural retrieval merges relations from multiple sources with priority order (D2):

1. **Field-backed** (highest priority) — task `parent`, task `spec`, task `fulfills`
2. **Inline refs** — parsed `@doc/...{relation}` and `@task-...{relation}` from content
3. **Code-graph edges** (lowest priority) — `imports`, `calls`, `extends` from code indexing

Deduplication: if the same (source, target, relation) tuple appears from multiple origins, keep the highest-priority origin as primary but preserve all origins in metadata.

## Acceptance Criteria

- [ ] AC-1: `search({ action: "resolve", ref: "@doc/specs/auth{implements}" })` returns typed neighbor edges with relation, direction, and origin metadata.
- [ ] AC-2: Adding `direction: "inbound"` returns entities that point TO the root entity via the specified relation.
- [ ] AC-3: Adding `depth: 2` returns multi-hop results with correct depth annotation on each edge.
- [ ] AC-4: Adding `relationTypes: "blocked-by,depends"` filters edges to only those relation kinds.
- [ ] AC-5: Adding `entityTypes: "task"` filters result entities to only tasks.
- [ ] AC-6: Field-backed relations (task parent, task spec) appear in results with `origin: "field-backed"`.
- [ ] AC-7: Inline ref relations appear with `origin: "inline"` and code-graph edges with `origin: "code-graph"`.
- [ ] AC-8: When the same (source, target, relation) exists from multiple origins, only one edge is returned with the highest-priority origin.
- [ ] AC-9: Unresolved edges are returned in a separate `unresolved` array with reason.
- [ ] AC-10: CLI `knowns resolve` supports `--direction`, `--depth`, `--relation`, `--type` flags with same semantics as MCP.
- [ ] AC-11: Depth-3 traversal on 500 entities completes within 500ms.
- [ ] AC-12: Doc rename triggers edge rewrite — structural retrieval returns correct results after rename.

## Scenarios

### Scenario 1: Happy path — find tasks implementing a spec

**Given** doc `specs/auth` exists and 3 tasks have `spec: specs/auth` field
**When** `resolve('@doc/specs/auth{implements}', direction: 'inbound')`
**Then** returns 3 edges with `relation: "implements"`, `direction: "inbound"`, `origin: "field-backed"`, each pointing to a task entity

### Scenario 2: Multi-hop traversal — blocked chain

**Given** task A is blocked-by task B, task B is blocked-by task C (via inline refs)
**When** `resolve('@task-A{blocked-by}', depth: 2)`
**Then** returns 2 edges: A→B at depth 1, B→C at depth 2, both with `origin: "inline"`

### Scenario 3: Mixed origins — deduplication

**Given** task X has `spec: specs/api` (field-backed) AND content contains `@doc/specs/api{implements}` (inline ref)
**When** `resolve('@doc/specs/api{implements}', direction: 'inbound')`
**Then** returns 1 edge for task X with `origin: "field-backed"` (higher priority wins)

### Scenario 4: Filtered traversal

**Given** doc `specs/api` has 5 inbound edges: 3 tasks and 2 docs
**When** `resolve('@doc/specs/api{references}', direction: 'inbound', entityTypes: 'task')`
**Then** returns only the 3 task edges

### Scenario 5: Unresolved edge

**Given** doc content contains `@doc/specs/deleted-feature{depends}` but that doc was deleted
**When** `resolve('@doc/specs/current{depends}')`
**Then** `edges` array excludes the broken ref; `unresolved` array contains it with `reason: "entity not found"`

### Scenario 6: Depth limit respected

**Given** a chain A→B→C→D→E each linked by `depends`
**When** `resolve('@doc/A{depends}', depth: 3)`
**Then** returns edges for A→B (depth 1), B→C (depth 2), C→D (depth 3). Does NOT include D→E.

### Scenario 7: Doc rename preserves edges

**Given** doc `specs/old-name` has inbound `implements` edges from 2 tasks
**When** doc is renamed to `specs/new-name`
**Then** `resolve('@doc/specs/new-name{implements}', direction: 'inbound')` returns the same 2 task edges

## Technical Notes

- Structural traversal reuses the existing reference parser from @doc/specs/semantic-reference-runtime.
- Edge collection should be lazy — collect edges at each depth level, filter, then expand next level only if depth allows.
- Consider caching resolved edge sets per entity for repeated traversals within the same request.
- The `resolve` action already returns expanded context; structural params add relation-aware structure on top.

## Open Questions

- [ ] Should structural retrieval results include a `path` field showing the full traversal chain for multi-hop edges?
- [ ] Should the WebUI graph view auto-expand structural retrieval results or require explicit user action?
- [ ] Should template-for relations be derived from template metadata or require explicit authoring?
