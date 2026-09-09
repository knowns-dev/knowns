---
id: 20260909-1451-managed-qdrant-starts-automatically-on-every-job-path-but-installs-only-on-reindex
title: Managed Qdrant starts automatically on every job path, but installs only on reindex
status: draft
supersedes: []
supersededBy: []
tags:
  - qdrant
  - runtime
  - lifecycle
  - search
sources:
  - '@doc/architecture/patterns/qdrant-vector-store-placement-pattern'
relatedDocs:
  - architecture/patterns/qdrant-vector-store-placement-pattern
relatedTasks:
  - KN-CM825F
  - i3yqo9
  - qimsp9
verification: []
reviewState: needs_evidence
reviewBlockers:
  - 'linked task "KN-CM825F" is "in-progress"; all linked tasks must be done before accepting candidate'
reviewMatches: []
reviewAllowedResolutions: []
reviewEvaluatedHash: 'c2c121220a4e2f6d3bb705c377459e4cd5c3aac96ef9e7b0b046e6f14ed295d5'
reviewEvaluatedAt: '2026-09-09T07:51:09.835Z'
createdAt: '2026-09-09T07:51:09.835Z'
updatedAt: '2026-09-09T07:51:09.835Z'
---

## Context

@doc/architecture/patterns/qdrant-vector-store-placement-pattern requires that Knowns manage the managed Qdrant lifecycle automatically, and lists both "Ensure the managed Qdrant binary or runtime is available" and "Start Qdrant when semantic vector operations require it" as onboarding behavior. It does not separate the two, and in practice they have very different costs.

Only the reindex job ever honored either. Two incidents followed from that: 2026-08-20 to 08-27 stranded 153 jobs across 8 projects, and 2026-09-09 stranded 74 across 3, both because a dead Qdrant stayed dead and every reconcile job burned its 8-attempt budget in roughly 4.25 minutes of backoff.

## Decision

Starting managed Qdrant is automatic and belongs on every job path that is about to talk to it. Installing it is not, and stays on the explicit reindex path alone.

Start is cheap, idempotent, and local. Install reaches the network when the local manifest does not match the pinned version, so a path that runs on every task or doc edit must never be able to trigger a download. A missing binary surfaces instead as the manager's not-installed error, which names its own remediation.

Any new code path that reaches Qdrant goes through Manager.EnsureRunning rather than assuming a live process or calling Start directly. Ensure memoizes both outcomes per runtime root, because the daemon runs one job at a time and an unstartable backend would otherwise block the whole queue for the readiness timeout once per job.

## Alternatives Considered

Start Qdrant once at daemon boot. Rejected: the daemon is shared across every registered project on the machine, most of which may not use the Qdrant backend at all, and it long outlives any single project's configuration.

Ensure inside the client constructor. Rejected: it would fire on read paths that are content to fall back to keyword search, turning a graceful degradation into a process spawn.

Also install on the reconcile path, matching what the pattern doc lists together. Rejected for the download risk above.

## Consequences

A reboot or a kill no longer strands the queue: the next edit brings the backend back. The mass dead-letter shape stays possible only when Qdrant genuinely cannot start, which is what `knowns runtime retry` and the `search.qdrant-dead-letters` doctor check exist for.

A project whose binary was never installed still cannot reconcile until a reindex or an explicit install runs. That is deliberate, and the error says so.

Not addressed here: the retry budget still treats "backend unavailable" the same as a data error, so 8 attempts over about 4.25 minutes still exhaust together during a genuine outage.
