# knowns decision migrate

Review and migrate legacy Decision Memories

Preview legacy Decision Memories without writes, apply one explicit reviewed resolution, or roll back a prior migration.

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## Subcommands

- [`knowns decision migrate apply`](knowns_decision_migrate_apply.md) — Apply one explicit reviewed migration resolution
- [`knowns decision migrate preview`](knowns_decision_migrate_preview.md) — Preview legacy Decision Memory candidates without writing
- [`knowns decision migrate rollback`](knowns_decision_migrate_rollback.md) — Roll back a reviewed legacy Decision Memory migration

## See also

- [`knowns decision`](knowns_decision.md) — Manage System Decision records

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
