# knowns runtime logs

Show runtime / MCP server log files

## Usage

```
knowns runtime logs [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `-f, --follow` | `bool` | — | Follow new log lines |
| `-s, --source` | `string` | `all` | Which log to read: runtime\|mcp\|all |
| `-n, --tail` | `int` | `50` | Number of trailing lines to show |

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## See also

- [`knowns runtime`](knowns_runtime.md) — Install and inspect runtime hooks and status integrations

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
