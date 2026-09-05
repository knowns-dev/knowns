---
id: 20260827-1529-defer-the-sub-agent-debate-harness-until-a-measurable-win-exists
title: Defer the sub-agent debate harness until a measurable win exists
status: draft
supersedes: []
supersededBy: []
tags:
  - agents
  - orchestration
  - anti-goal
  - deferred
  - research
sources:
  - '@doc/research/knowns-evolution-research-2026'
  - internal/tasklifecycle/public_test.go
  - internal/mcp/handlers/doc.go
  - 'https://arxiv.org/html/2607.26212v1'
relatedDocs:
  - research/knowns-evolution-research-2026
relatedTasks: []
verification: []
reviewState: needs_evidence
reviewBlockers:
  - candidate needs at least one linked task or a spec with linked tasks before acceptance
reviewMatches: []
reviewAllowedResolutions: []
reviewEvaluatedAt: '2026-08-27T08:29:39.357Z'
createdAt: '2026-08-27T08:29:39.357Z'
updatedAt: '2026-08-27T08:29:39.357Z'
---

## Context

A harness letting sub-agents debate each other was researched end to end on 2026-08-27. It is technically feasible: the hard primitive already exists and is tested. `internal/tasklifecycle/public_test.go` → `TestUpdateTaskConcurrentSameBaseHasOnePublicWinner` runs two concurrent services updating one task from the same base hash and asserts exactly one winner, `storage.ErrHistoryConflict` for the loser, exactly one new history revision, exactly one index-hook call, and no content leak in the loser's error. `expectedHash` is wired through MCP on both `doc.update` and `task.update`. That is leaderless compare-and-swap — enough to build a peer blackboard with no coordinating master.

What is missing is evidence that debate helps. A survey of 141 multi-agent-debate studies (arxiv 2607.26212) reports the field converged on a narrow design pattern "by convention rather than systematic comparison," and the two findings that reproduce most clearly are downside risks: judge quality dominates outcomes, and inter-agent sycophancy reinforces bias.

The project's own @doc/research/knowns-evolution-research-2026 Anti-Goal 7 already governs this: "Do not use multi-agent orchestration by default. Complexity should be justified by a measurable win over the simple phased baseline." Its Priority Matrix lists three P0 "Build now" workstreams; a debate harness appears at no priority level.

A session in this repository then demonstrated the failure mode first-hand. Five sub-agents on one cheap model tier produced a well-evidenced critique, but all five missed the same four factual errors, which a different model tier caught on the first pass. Agreement among same-tier agents was not corroboration.

## Decision

Do not build a sub-agent debate harness now.

The gate to revisit is the one Anti-Goal 7 already names: a measurable win over the simple phased baseline. The cheapest experiment that could produce it is a bounded adversarial pass over `kn-review` P1 findings, measured against the pain that skill already documents ("Not everything is P1. Severity inflation wastes time"), with the outcome metric being a reduction in false P1s.

When multiple agents are used for a question that matters, fan out to generate hypotheses and change model tier to verify them. Same-tier agreement is not evidence.

## Alternatives Considered

Build the peer blackboard mesh now — per-peer lane docs under `debates/<slug>/round-<t>/`, a CAS-guarded `state` document, a filesystem round barrier, and a collective stop predicate. Rejected: it is the shape a leaderless design should take, and the primitives are real, but roster, barrier, and stop predicate would live only in prompt text with nothing enforcing them, and nothing measures whether the output is better.

Use the Workflow tool's existing judge-panel and adversarial-verify patterns instead of a new harness. Not rejected — this is the cheap path if the experiment above is ever run. It needs no new Knowns surface.

## Consequences

No code changes. The research does not need repeating; the substrate findings above are the durable part.

Building this later would touch @decision/20260819-1703-remove-the-opencode-chat-ui, which removed Knowns' own agent runtime and states that Knowns "no longer manages a runtime service of its own." Any debate harness must therefore live in the skill layer with Knowns providing state, not process management.

This draft has a standing review blocker because it has no linked task. That is expected — the decision is not to do work.
