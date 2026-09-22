---
id: 20260828-0249-task-dependencies-are-declared-as-blocked-by-edges-order-is-display-sequence-only
title: Task dependencies are declared as blocked-by edges; order is display sequence only
status: draft
supersedes: []
supersededBy: []
tags:
  - workflow
  - skills
  - graph
  - tasks
sources:
  - 'internal/references/references.go:24-34'
  - 'internal/storage/structural_edges.go:186'
  - 'internal/storage/structural_traversal_test.go:76'
  - internal/instructions/skills/kn-plan/SKILL.md
  - internal/instructions/skills/kn-flow/SKILL.md
  - internal/instructions/skills/contracts_test.go
relatedDocs:
  - specs/structural-knowledge-retrieval
  - specs/semantic-reference-runtime
relatedTasks:
  - q0wmpy
verification: []
reviewState: ready_for_review
reviewBlockers: []
reviewMatches: []
reviewAllowedResolutions:
  - accept_new
  - reject_new
reviewEvaluatedAt: '2026-08-27T19:49:42.025Z'
createdAt: '2026-08-27T19:49:42.025Z'
updatedAt: '2026-08-27T19:49:42.025Z'
---

## Context

The reference system has allowed `depends` and `blocked-by` since it was written (`internal/references/references.go:24-34`), `internal/storage/structural_edges.go:186` turns inline task refs into graph edges, and `StructuralResolve` traverses them — a multi-hop `blocked-by` chain is already covered by a passing test at `internal/storage/structural_traversal_test.go:76`.

None of that was reached. Across 35 tasks the project held exactly one relation-annotated ref (`{implements}`) and zero `depends`/`blocked-by`. All ten occurrences in docs were specs describing the syntax, not edges. No Go code outside the allowlist referenced either kind.

The graph was empty because nothing wrote to it: `kn-plan` generated tasks with `order NN * 10` and no edges, while `kn-flow` sorted by `order` and judged dependencies from prose. `order` is a display field, so a dependency existed only in whoever remembered it, and each run re-derived it.

## Decision

A real dependency between tasks is declared as an inline `@task-<UPSTREAM_ID>{blocked-by}` ref in the dependent task's description. `order` carries display sequence only, and no skill may read dependency from it or write sequence as a substitute for an edge.

An edge is declared only where the dependent task cannot start, or cannot be verified, until the upstream task's output exists. Shared subject matter, adjacent files, and neighbouring `order` values are not dependencies. Cycles are never declared: two tasks that each need the other's output are one task, or the split is wrong. Absent an edge is preferred over a speculative one, because an invented dependency serialises work that could have run in parallel and is as invisible afterwards as a missing one.

Every skill that consumes task ordering resolves declared edges before judging dependencies from task text. A task is runnable only when every task it declares `blocked-by` is done.

## Alternatives Considered

**Promote `order` to mean dependency.** Rejected: `order` is a single integer per task, so it cannot express that two tasks are unordered relative to each other. It can only produce a total order, which serialises work that has no reason to be sequential.

**Add a first-class `dependsOn` field to the Task model.** Rejected as unnecessary. `models.Task` would gain a field, storage a migration, and validation a new path, to reach a graph the inline-ref pipeline already builds and already traverses under test. The gap was never representational.

**Build the wave scheduler first (cycle detection in `validate`, topological wave computation).** Rejected on sequencing, not on merit. Against a graph with no edges a scheduler emits one wave containing every task. It becomes worth building once spec-generated tasks have accumulated real edges — which this decision is what produces.

## Consequences

Dependencies become durable, inspectable data rather than per-run reasoning: an edge written once is read by every later run, survives compaction, and shows up in `search.resolve` and the graph route.

The cost lands on task generation, which must now create upstream tasks before dependent ones so the IDs exist, and must surface declared edges in the preview so approval covers the shape of the graph rather than only the list of tasks.

The main risk is over-declaration. An agent that declares an edge for every adjacent-looking pair rebuilds a total order in a new syntax and quietly removes parallelism, which is why "prefer no edge" is part of the rule and not advice.

Enforcement is marker-level, not behavioural: `TestDependencyEdgesAreDeclaredNotInferred` fails if either the producing or the consuming half is removed, but no test yet proves an agent actually emits an edge when a real dependency exists. Until edges accumulate in practice, this decision is expected to hold rather than proven to.
