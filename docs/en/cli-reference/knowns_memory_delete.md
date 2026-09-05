# knowns memory delete

Delete a memory entry

## Usage

```
knowns memory delete <id> [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--dry-run` | `bool` | — | Preview what would be deleted |
| `--force` | `bool` | — | Skip confirmation prompt |

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
