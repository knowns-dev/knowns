---
title: Task Lifecycle
description: User and operator guide for Task lifecycle visibility, archival, recovery, and Hard Delete.
createdAt: '2026-07-22T04:43:30.907Z'
updatedAt: '2026-07-22T04:44:30.870Z'
tags:
  - feature
  - tasks
  - lifecycle
  - retrieval
  - archive
  - operator
---

# Task Lifecycle

Task Lifecycle keeps completed work out of default AI context without deleting its history. It separates reversible archive operations from trusted, irreversible Hard Delete.

Source of truth: @doc/specs/2026-07-21/task-lifecycle-context-hygiene. Implementation tasks: @task-vr4vz2, @task-d8sxrv, @task-9jb2yo, @task-melsmw, @task-vxccet, and @task-32xjeo.

## States

| State | Canonical meaning | Default human Search | Default AI Retrieve |
|---|---|---:|---:|
| active | Task is not `done` and is stored in `tasks/` | included | included |
| done | Task status is `done`; `completedAt` records the transition | included | excluded by the default project policy |
| archived | Task is stored in `archive/`; `archivedAt` records the transition when available | excluded | excluded |
| hard-deleted | Task content is gone; only a content-free tombstone remains | excluded | excluded |

Hard-deleted is not a recoverable Task state. The tombstone reserves the Task ID and stores only ID, deletion time, actor, and reason.

Changing a Task to `done` sets `completedAt`. Reopening it clears `completedAt` and `archivedAt`, restores an active status, and reconciles the search index. Direct Task lookup by ID continues to work for archived Tasks.

## Search and AI context

Human `Search` is for discovery: active and done Tasks are visible by default. Archived Tasks require an explicit historical query.

AI `Retrieve` is for context assembly: with the default `excludeDoneFromDefaultRetrieval: true`, only active Tasks participate in keyword, semantic, hybrid, reference expansion, and context-pack paths. This prevents completed Plans and Notes from re-entering context through a stale or rebuilt index.

Use historical retrieval explicitly when investigating earlier work:

```bash
knowns search "retention policy" --type task --include-historical --plain
knowns retrieve "why was retention chosen" --source-types task --include-historical --plain
```

For MCP, set `includeHistorical: true` on `search.search` or `search.retrieve`. Historical Task results are grouped active, then done, then archived, with relevance ordering inside each group and lifecycle metadata on the result.

If `excludeDoneFromDefaultRetrieval` is set to `false`, default AI retrieval may include active and done Tasks by relevance. Archived Tasks still require `includeHistorical`.

## Project settings

The canonical project settings are under `settings.taskLifecycle` in `.knowns/config.json`:

```json
{
  "settings": {
    "taskLifecycle": {
      "excludeDoneFromDefaultRetrieval": true,
      "autoArchive": true,
      "archiveAfter": "30d",
      "purgeAfter": null
    }
  }
}
```

Defaults:

- `excludeDoneFromDefaultRetrieval: true`
- `autoArchive: true`
- `archiveAfter: "30d"`
- `purgeAfter: null`

Legacy projects with no `taskLifecycle` block receive these effective defaults in memory; loading, searching, or reindexing does not rewrite their config or Task Markdown. Global defaults seed new projects, while existing project-local values win and forced init preserves them.

`archiveAfter: "0s"` means an eligible done Task has no retention delay. It is different from `autoArchive: false`, which disables automatic archive entirely. Durations accept Go duration syntax and whole-day values such as `30d`; negative and empty values are rejected. `purgeAfter: null` means no purge. The automatic sweeper never Hard Deletes Tasks.

## Archive eligibility and blockers

A Task is eligible for automatic archive only when:

- its status is `done`;
- its age is measured from `completedAt` and meets `archiveAfter`;
- it has no active timer; and
- every descendant Task is terminal.

The preview returns stable reason codes and deadlines for blockers such as retention pending, active timers, unfinished descendants, disabled auto-archive, already active/archived state, or malformed state. Corrupt timer data fails closed.

References to Docs, Decisions, Memories, or other durable knowledge produce a non-blocking warning. Review the warning before archiving; extract reusable knowledge when appropriate.

## Preview-first operations

Every surface uses the same lifecycle request/result contract. Archive and batch operations preview by default and mutate only after explicit execution.

```bash
# Preview one Task, then execute the same operation
knowns task archive <id>
knowns task archive <id> --yes

# Preview all eligible Tasks or an exact ID set
knowns task batch-archive
knowns task batch-archive <id-a> <id-b>
knowns task batch-archive <id-a> <id-b> --yes

# Restore
knowns task unarchive <id>
knowns task unarchive <id> --yes
knowns task batch-unarchive <id-a> <id-b> --yes
```

The response reports eligible, skipped, unchanged, and changed items, stable reason codes, warnings, timestamps, deadlines, and partial progress. A retry must use the same frozen ID set from the preview; it is idempotent and repairs pending derived-index work without repeating canonical transitions.

MCP actions are `tasks.archive`, `tasks.unarchive`, `tasks.batch_archive`, and `tasks.batch_unarchive`. Pass `execute: false` or omit it for preview; pass `execute: true` to mutate.

WebUI exposes lifecycle settings, state/timestamp badges, single-Task actions, and batch preview/confirmation. Archived and All views make an explicit historical request and update on lifecycle SSE events.

## Hard Delete

Hard Delete is separate from archive and requires all of the following:

- a trusted `task:hard-delete` capability or equivalent server-side permission;
- explicit confirmation; and
- a non-empty audit reason.

CLI example:

```bash
knowns task hard-delete <id> --allow-hard-delete --yes --reason "approved retention request"
```

MCP uses `tasks.hard_delete` with `taskId`, `confirmed: true`, and `reason`. HTTP/WebUI capabilities are server-derived; request headers or client JSON cannot grant permission.

Hard Delete removes the Task, Plan, Notes, references, history, time data, and derived index content, then retains a content-free tombstone. The ID cannot be reused. A tombstone cannot reconstruct deleted content, so backups or repository history are the only recovery path after deletion.

## Events, retries, and operator recovery

Lifecycle events carry a stable `Event.ID`. Delivery is AT-LEAST-ONCE: after a crash, the same event may be delivered again with the same ID. Consumers must deduplicate by `Event.ID`, not by timestamp or Task ID.

Canonical Task storage and tombstones are authoritative. Derived index reconciliation and event delivery run outside the lifecycle lock and are checkpointed. A failure may therefore return completed canonical progress plus a warning/error and a pending repair. The next identical lifecycle operation or automatic sweep resumes the pending checkpoint idempotently.

The server runs a bounded sweep at startup and then periodically (one hour by default, with a two-minute run timeout). It archives eligible Tasks only; it does not purge. If a sweep partially fails while updating a derived index, it reports the failed Task and continues processing other items. A later sweep retries the pending checkpoint. Persistent model/index/config failures require operator repair before the checkpoint can clear.

Operational checks:

1. Inspect the lifecycle response and `failedTaskId`.
2. Preserve the original ID set for retry.
3. Repair semantic model/index/config readiness if derived reconciliation failed.
4. Retry the same operation or allow the next sweep.
5. Verify historical retrieval and direct lookup for archive/reopen; verify the tombstone and absence of Task content for Hard Delete.

## Compatibility guarantees

Pre-lifecycle Task Markdown, including legacy archived files, missing lifecycle timestamps, CRLF line endings, unknown YAML keys, and custom body sections remains readable. Read-only load and full reindex do not rewrite canonical files. Lifecycle mutations patch lifecycle frontmatter while preserving unknown frontmatter and custom Markdown.

Reindex includes active, done, and archived Task chunks so explicit historical retrieval remains complete. Query-time canonical lifecycle filtering prevents stale, deleted, done, or archived content from leaking into default AI context.
