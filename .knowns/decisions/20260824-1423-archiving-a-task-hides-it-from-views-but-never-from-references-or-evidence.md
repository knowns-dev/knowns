---
id: 20260824-1423-archiving-a-task-hides-it-from-views-but-never-from-references-or-evidence
title: Archiving a Task hides it from views but never from references or evidence
status: draft
supersedes: []
supersededBy: []
tags:
  - archive
  - storage
  - references
sources: []
relatedDocs: []
relatedTasks:
  - cnqs7l
  - cbfsiy
verification: []
reviewState: needs_evidence
reviewBlockers:
  - candidate needs at least one source before acceptance
reviewMatches: []
reviewAllowedResolutions: []
reviewEvaluatedAt: '2026-08-24T07:23:31.614Z'
createdAt: '2026-08-24T07:23:31.614Z'
updatedAt: '2026-08-24T07:23:31.614Z'
---

## Context

Tasks.List() returned only .knowns/tasks/, so 22 of 24 call sites silently dropped archived work. AutoArchive is on by default at 30d, so every project decayed into this: doc-to-task links stopped resolving, Decision acceptance lost its spec evidence, spec AC coverage fell 32% on knowns-go, and CLI/MCP list could not show archived Tasks at all.

## Decision

Treat archiving as a view concern, not a deletion. Any path that resolves references, aggregates evidence, or reports totals must use Tasks.ListAll(); only surfaces that answer 'what am I working on now' use Tasks.ListActive(). There is no Tasks.List(): the name was removed so the compiler forces each call site to state its intent. User-facing lists hide archived work by default and reveal it through includeHistorical, matching the flag that already exists on search.

## Alternatives Considered


## Consequences

New consumers must choose explicitly and cannot inherit the wrong default by accident. ListAll costs a second directory scan, filters tombstoned IDs, and recomputes subtask links across the boundary. BuildCodeGraph deliberately stays active-only because it has no visibility flag and would otherwise emit dangling edges.
