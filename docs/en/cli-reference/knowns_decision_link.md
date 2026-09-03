# knowns decision link

Link docs, tasks, or sources to a decision

## Usage

```
knowns decision link <id> [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--doc` | `stringArray` | — | Related doc path (repeatable) |
| `--source` | `stringArray` | — | Source reference (repeatable) |
| `--task` | `stringArray` | — | Related task ID (repeatable) |

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## See also

- [`knowns decision`](knowns_decision.md) — Manage System Decision records

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
