# knowns time add

Manually add a time entry (e.g. 2h, 30m)

## Usage

```
knowns time add <taskId> <duration> [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `-d, --date` | `string` | — | Date (YYYY-MM-DD, defaults to today) |
| `--expected-hash` | `string` | — | Expected canonical task hash |
| `-n, --note` | `string` | — | Note for this time entry |

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## See also

- [`knowns time`](knowns_time.md) — Time tracking

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
