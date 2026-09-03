# knowns decision create

Create a decision record

## Usage

```
knowns decision create <title> [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--alternatives` | `string` | — | Alternatives Considered section body |
| `--body` | `string` | — | Full markdown decision body |
| `--consequences` | `string` | — | Consequences section body |
| `--context` | `string` | — | Context section body |
| `--decision` | `string` | — | Decision section body |
| `--doc` | `stringArray` | — | Related doc path (repeatable) |
| `--source` | `stringArray` | — | Source reference (repeatable) |
| `--status` | `string` | — | Decision status; new System Decisions must be draft |
| `-t, --tag` | `stringArray` | — | Decision tag (repeatable) |
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
