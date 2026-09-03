# knowns task unarchive

Restore a task from the archive

## Usage

```
knowns task unarchive <id> [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--expected-hash` | `string` | — | Expected canonical hash for optimistic concurrency |
| `--yes` | `bool` | — | Execute; otherwise preview only |

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## See also

- [`knowns task`](knowns_task.md) — Manage tasks

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
