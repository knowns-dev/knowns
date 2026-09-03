# knowns decision resolve

Resolve a persisted System Decision candidate

Resolve a persisted candidate with accept_new, link_as_related, reject_new, or supersede_existing. Link and replace require --target.

## Usage

```
knowns decision resolve <resolution> <candidate-id> [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--replacement-id` | `string` | — | Existing verified replacement Decision ID for supersede_existing |
| `--target` | `string` | — | Existing Decision ID required by link_as_related or supersede_existing |

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
