# knowns task history

Show version history of a task

## Usage

```
knowns task history <id> [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--limit` | `int` | `0` | Metadata page size (0 means all) |
| `--metadata` | `bool` | — | List payload-free revision metadata |
| `--offset` | `int` | `0` | Metadata page offset (newest first) |
| `--revision` | `string` | — | Load one revision detail (vN or numeric) |

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
