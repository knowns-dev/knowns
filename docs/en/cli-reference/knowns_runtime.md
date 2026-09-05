# knowns runtime

Install and inspect runtime hooks and status integrations

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## Subcommands

- [`knowns runtime install`](knowns_runtime_install.md) — Install a runtime memory adapter
- [`knowns runtime logs`](knowns_runtime_logs.md) — Show runtime / MCP server log files
- [`knowns runtime memory`](knowns_runtime_memory.md) — Manage runtime memory hook behavior
- [`knowns runtime ps`](knowns_runtime_ps.md) — Show live runtime processes and jobs, not readiness or integration status
- [`knowns runtime reload`](knowns_runtime_reload.md) — Reload shared runtime semantic providers and config
- [`knowns runtime status`](knowns_runtime_status.md) — Show runtime hook and integration installation state
- [`knowns runtime stop`](knowns_runtime_stop.md) — Request the shared runtime to shut down gracefully
- [`knowns runtime uninstall`](knowns_runtime_uninstall.md) — Remove a runtime memory adapter

## See also

- [`knowns`](knowns.md) — The memory layer for AI-native software development

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
