---
id: doc-12ece0d9956aaee2b9448cc2cb09426c
title: Semantic Reference Runtime
description: Design notes for stable entity IDs, mutable paths, semantic ref resolution, and inline WebUI rendering.
createdAt: '2026-04-15T08:33:06.772Z'
updatedAt: '2026-04-15T08:35:23.134Z'
tags:
  - feature
  - references
  - semantic
  - webui
  - design
---

# Semantic Reference Runtime

This doc captures the proposed semantic reference design for Knowns, with emphasis on stable entity identity, path changes, and WebUI inline rendering.

## Context

Current refs are path- or ID-shaped strings such as `&commat;doc/<path>`, `&commat;task-<id>`, and `&commat;template/<name>` as described in @doc/guides/reference-system-guide. Retrieval and expansion behavior already exists in the retrieval foundation from @doc/specs/rag-retrieval-foundation. The `&commat;code/` work in @doc/specs/ast-code-intelligence shows that Knowns can extend the reference system with richer syntax.

## Problem

Path-based doc refs are brittle.

Example:

- Existing ref: `&commat;doc/patterns/auth`
- Doc path renamed to: `security/auth-architecture`

If path is the canonical identity, the old ref breaks:

- validation reports a broken ref
- graph edges disappear
- retrieval expansion no longer resolves the target
- WebUI cannot render a friendly resolved link

## Core Decision

For semantic refs, **entity identity should be stable and separate from display path**.

### Recommended doc model

```json
{
  "id": "auth",
  "path": "security/auth-architecture",
  "title": "Authentication Architecture",
  "aliases": ["patterns/auth"]
}
```

### Meaning of fields

- `id`: stable canonical identity used for resolution
- `path`: mutable storage/navigation path
- `title`: human-facing label for UI
- `aliases`: optional backward-compatibility lookup for renamed paths

## Canonical Reference Shape

Recommended semantic doc refs should target stable IDs:

```md
&commat;doc/auth
&commat;doc/auth{implements}
&commat;doc/auth{references}
```

### Backward compatibility

Old path-shaped refs may still be accepted as lookup input, but they should resolve to the canonical entity ID internally.

Example:

- author writes `&commat;doc/patterns/auth`
- resolver maps it to doc id `auth`
- WebUI renders the resolved title

## Resolution Model

A semantic ref should resolve into a structured object.

```json
{
  "raw": "&commat;doc/auth{implements}",
  "entity": {
    "type": "doc",
    "id": "auth",
    "path": "security/auth-architecture",
    "title": "Authentication Architecture"
  },
  "relation": "implements",
  "resolved": true
}
```

### Default relation

If no relation is supplied, default to `references`.

```md
&commat;doc/auth
```

is equivalent to:

```md
&commat;doc/auth{references}
```

## Path Rename Behavior

When a doc path changes:

1. keep the same stable `id`
2. update the current `path`
3. optionally add the old path to `aliases`
4. resolve old path-shaped refs to the same entity when possible
5. render the latest title/path in UI

### Expected outcome

A ref such as `&commat;doc/auth{implements}` should continue to work after a rename because the `id` is unchanged.

## WebUI Inline Rendering

Raw markdown remains authoring syntax. Read mode should render resolved refs inline.

### Read mode

```md
Implements &commat;doc/auth{implements}.
See also &commat;doc/auth.
```

renders conceptually as:

- **Authentication Architecture** `implements`
- **Authentication Architecture**

### Rendering rules

- plain ref: render the resolved entity title as a normal link
- semantic ref: render the resolved entity title as a link plus a small relation badge
- unresolved ref: render a warning style with tooltip or error state
- do not expose raw syntax in normal read mode unless resolution fails

### Hover / click behavior

Hover or click should show resolved metadata:

- type
- stable id
- current path
- title
- relation
- resolved / unresolved state

## Graph Behavior

Graph edges should use the semantic relation instead of generic `mention` when relation metadata exists.

Examples:

- `task/backend-auth --implements--> doc/auth`
- `task/login --blocked-by--> task/db-migration`
- `doc/security --related--> doc/auth`

This keeps graph intelligence aligned with semantic refs instead of plain mention extraction.

## Practical Guidance

- Use stable IDs as canonical semantic targets
- Treat path as mutable metadata, not primary identity
- Keep path lookup only as compatibility or migration support
- Render entity title for humans; keep id/path in inspector metadata
- Prefer relation badges only for semantic refs to avoid noisy text

## Suggested Scope For First Rollout

1. shared semantic ref parser
2. resolver returning structured entity + relation metadata
3. validate and graph consume the parsed relation
4. WebUI inline render resolved refs
5. optional CLI/MCP `resolve` entrypoint later
