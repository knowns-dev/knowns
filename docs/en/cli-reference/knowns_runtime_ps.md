# knowns runtime ps

Show live runtime processes and jobs, not readiness or integration status

Show live shared runtime status: managed services, connected clients,
current queue activity, and bounded recent job failures.

Use this for process and queue visibility. For project readiness, use knowns status.
For diagnostics and remediation, use knowns doctor. For runtime hook or plugin
installation state, use knowns runtime status. For raw logs, use knowns runtime logs.

## Usage

```
knowns runtime ps [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--all` | `bool` | — | Show all retained recent jobs |
| `--clients` | `int` | `6` | Number of connected clients to show in compact output (0 hides client rows) |
| `--failed` | `bool` | — | Show only failed recent jobs |
| `--failures` | `int` | `3` | Number of grouped recent failures to show in compact output (0 hides failure rows) |
| `--interval` | `duration` | `2s` | Refresh interval when --watch is set |
| `--jobs` | `bool` | — | Show detailed runtime job history |
| `--tail` | `int` | `10` | Number of recent jobs to show when job details are enabled |
| `-w, --watch` | `bool` | — | Refresh continuously |

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
