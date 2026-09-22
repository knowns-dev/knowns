# knowns runtime retry

Release retained Qdrant dead-letter jobs back to the scheduler

Release retained Qdrant dead-letter jobs so the runtime schedules them again.

A job is dead-lettered once it exhausts its 8-attempt retry budget. During an
extended Qdrant outage every pending reconcile job can exhaust that budget at
the same time, stranding a whole backlog: nothing else clears the flag, and
the entity is never indexed unless it happens to be edited again.

Pass explicit job IDs to release specific jobs, --all to release every dead
letter in the current project, or --all-projects to sweep every project
registered with the shared runtime. --dry-run reports what would be released
without acquiring the queue lock or mutating anything.

## Usage

```
knowns runtime retry [jobID...] [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--all` | `bool` | — | Release every retained Qdrant dead letter in the current project |
| `--all-projects` | `bool` | — | Release every retained Qdrant dead letter across all registered projects |
| `--dry-run` | `bool` | — | Report what would be released without mutating the queue |

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## See also

- [`knowns runtime`](knowns_runtime.md) — Install and inspect runtime hooks and status integrations

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
