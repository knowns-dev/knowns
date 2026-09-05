# knowns audit recent

Show recent MCP tool calls

## Usage

```
knowns audit recent [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--limit` | `int` | `50` | Maximum number of events to show |
| `--project` | `string` | — | Filter by project root path |
| `--result` | `string` | — | Filter by result (success, error, denied) |
| `--tool` | `string` | — | Filter by tool name |

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## See also

- [`knowns audit`](knowns_audit.md) — Inspect MCP tool call audit trail

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
