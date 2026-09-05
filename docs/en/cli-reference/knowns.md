# knowns

The memory layer for AI-native software development

## Usage

```
knowns [options] [command]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## Subcommands

- [`knowns agents`](knowns_agents.md) — Manage agent instruction files
- [`knowns audit`](knowns_audit.md) — Inspect MCP tool call audit trail
- [`knowns board`](knowns_board.md) — Show the Kanban board
- [`knowns browser`](knowns_browser.md) — Launch the Knowns web UI
- [`knowns code`](knowns_code.md) — Code intelligence commands
- [`knowns config`](knowns_config.md) — Manage project configuration
- [`knowns decision`](knowns_decision.md) — Manage System Decision records
- [`knowns doc`](knowns_doc.md) — Manage documentation
- [`knowns doctor`](knowns_doctor.md) — Diagnose project and local integration health
- [`knowns eval`](knowns_eval.md) — Evaluate deterministic quality gates
- [`knowns import`](knowns_import.md) — Manage imported Knowns packages
- [`knowns init`](knowns_init.md) — Initialize a new Knowns project
- [`knowns lsp`](knowns_lsp.md) — Manage LSP language servers
- [`knowns mcp`](knowns_mcp.md) — Start the MCP (Model Context Protocol) server
- [`knowns memory`](knowns_memory.md) — Manage memory entries
- [`knowns migrate`](knowns_migrate.md) — Apply pending project config schema migrations
- [`knowns provider`](knowns_provider.md) — Manage embedding API providers
- [`knowns qdrant`](knowns_qdrant.md) — Inspect and control the semantic Qdrant runtime
- [`knowns reconcile`](knowns_reconcile.md) — Preview or apply canonical Task/Doc filesystem reconciliation
- [`knowns resolve`](knowns_resolve.md) — Resolve a semantic reference
- [`knowns retrieve`](knowns_retrieve.md) — Retrieve ranked context for docs, tasks, and memories
- [`knowns runtime`](knowns_runtime.md) — Install and inspect runtime hooks and status integrations
- [`knowns search`](knowns_search.md) — Search tasks and documentation
- [`knowns settings`](knowns_settings.md) — Open interactive project settings
- [`knowns setup`](knowns_setup.md) — Configure AI tool integrations
- [`knowns status`](knowns_status.md) — Show project readiness summary
- [`knowns sync`](knowns_sync.md) — Sync project from config.json (skills, instructions, model, search index)
- [`knowns task`](knowns_task.md) — Manage tasks
- [`knowns template`](knowns_template.md) — Manage code generation templates
- [`knowns time`](knowns_time.md) — Time tracking
- [`knowns tunnel`](knowns_tunnel.md) — Manage Cloudflare Quick Tunnels for the local server
- [`knowns update`](knowns_update.md) — Update Knowns CLI to the latest version and sync project configs
- [`knowns validate`](knowns_validate.md) — Validate tasks, docs, and templates

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
