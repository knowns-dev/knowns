# knowns task hard-delete

Permanently delete a task and retain a content-free tombstone

## Usage

```
knowns task hard-delete <id> [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--allow-hard-delete` | `bool` | — | Grant this local CLI invocation hard-delete capability |
| `--reason` | `string` | — | Required deletion reason |
| `--yes` | `bool` | — | Explicitly confirm permanent deletion |

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
