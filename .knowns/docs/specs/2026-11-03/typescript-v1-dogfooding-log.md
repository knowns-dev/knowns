---
id: doc-cf43bc1b2def706508a1fe44daf93c3f
title: TypeScript v1 dogfooding log
description: Daily log for the 14-day maintainer dogfooding of the TypeScript build on this repository (TSR-9VVJA6 AC3, spec D11)
createdAt: '2026-11-06T06:01:59.325Z'
updatedAt: '2026-11-06T16:23:42.799Z'
tags:
  - dogfood,release-gate,typescript-rewrite
---

## Purpose

D11 requires the maintainer to use the TypeScript build on this repository for at least 14 consecutive days with no data-loss bug before v1.0.0 ships. This log is the evidence for @task-TSR-9VVJA6 AC3. Spec: @doc/specs/2026-11-03/knowns-typescript-rewrite

## Setup

- Binary: `~/.knowns-ts/bin/knowns` (wrapper) -> `knowns-ts-bin`, built from commit 0fcb2f2, reports `knowns version 1.0.0-dogfood.0fcb2f2`.
- Scope: this repository only. The other projects and the global Claude Code hooks keep Go 0.34.1 at `~/.knowns/bin/knowns`.
- Runtime: the wrapper sets `KNOWNS_RUNTIME_ROOT=~/.knowns-ts/runtime`, so the TS runtime daemon never replaces the shared Go daemon (a client that sees a different daemon version shuts it down, cli/src/runtime/queue.ts ensureDaemon). Managed Qdrant, global memory and the registry are shared with Go, as after a real upgrade.
- Mixed writers are expected: Go hooks and other sessions may still write this repo's .knowns. Both must coexist (D10).
- Rebuilds: record each new dogfood build (commit, date) below; the 14-day clock does not reset on a rebuild, only on a data-loss bug.

## Rules

- A data-loss bug is any lost, silently changed or unreadable task, doc, memory, decision, time entry or history record, or a .knowns state that 0.34.x cannot read. It resets the clock.
- Other bugs are logged with a task link and do not reset the clock.
- Each day: one line with the date, what was used (CLI, MCP, UI, search, hooks), and issues found, then run `knowns validate` with both binaries.

## Log

| Day | Date | Build | Used | Issues | validate TS / Go |
|---|---|---|---|---|---|
| 0 | 2026-11-06 | 0fcb2f2 | install, task list, doc create (this doc) | none | pending |
| 0 | 2026-11-06 | 0fcb2f2 | MCP over TS (claude mcp local scope), task hard-delete KN-VPA58K | hard-delete refused: filesystem reconciliation rejects legacy docs without a stable id (122/156 docs here); no bytes changed, same as Go 0.34.1. Not data loss. Follow-up with knowns-4b. | 0 errors / 0 errors |
| 0 | 2026-11-06 | 0b988bf | rebuilt dogfood binary; validate --fix gave 122 legacy docs a stable id (one id line each, nothing else changed); hard-delete KN-VPA58K completed (file and history purged, tombstone kept) | none | 0 errors / 0 errors |
| 0 | 2026-11-06 | 5d31aa5 | rebuilt dogfood binary from a clean worktree (wave 11 + Rosetta installer fix); stopped the old 0b988bf dogfood daemon so the next client starts the new one; task create/edit/done (KN-N2M8CS), time add, search (semantic + keyword), validate | none | 0 errors / 0 errors |
