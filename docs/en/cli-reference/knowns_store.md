# knowns store

Keep project knowledge in a shared Git store instead of the repository

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## Subcommands

- [`knowns store link`](knowns_store_link.md) — Link this repository to a knowledge store
- [`knowns store resolve`](knowns_store_resolve.md) — Settle conflicting changes that paused a project's sync
- [`knowns store status`](knowns_store_status.md) — Show sync state for every repository linked to a store
- [`knowns store unlink`](knowns_store_unlink.md) — Remove this repository's link to a knowledge store

## See also

- [`knowns`](knowns.md) — The memory layer for AI-native software development

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
