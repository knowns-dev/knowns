# knowns audit stats

Show MCP tool call statistics

## Usage

```
knowns audit stats [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--project` | `string` | — | Filter by project root path |
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
