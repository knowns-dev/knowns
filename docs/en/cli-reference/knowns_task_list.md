# knowns task list

List tasks

## Usage

```
knowns task list [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--assignee` | `string` | — | Filter by assignee |
| `--include-historical` | `bool` | — | Include historical entities, including archived Tasks |
| `--label` | `string` | — | Filter by label |
| `--priority` | `string` | — | Filter by priority |
| `--status` | `string` | — | Filter by status |
| `--tree` | `bool` | — | Show tasks as tree hierarchy |

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
