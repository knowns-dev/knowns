# knowns memory list

List memory entries

## Usage

```
knowns memory list [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--all-statuses` | `bool` | — | Include non-active memory statuses |
| `--category` | `string` | — | Filter by category |
| `--layer` | `string` | — | Filter by layer (working, project, global) |
| `--status` | `string` | — | Filter by memory status |
| `--tag` | `string` | — | Filter by tag |

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## See also

- [`knowns memory`](knowns_memory.md) — Manage memory entries

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
