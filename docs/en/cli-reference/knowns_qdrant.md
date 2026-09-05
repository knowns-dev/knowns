# knowns qdrant

Inspect and control the semantic Qdrant runtime

Inspect and control the Qdrant runtime used by semantic vector search.

Managed mode owns a local Qdrant process rooted at ~/.knowns/runtime/qdrant.
External URL mode reports the configured endpoint and bypasses local process
start/stop/cleanup ownership.

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## Subcommands

- [`knowns qdrant cleanup`](knowns_qdrant_cleanup.md) — Remove stale managed Qdrant runtime metadata
- [`knowns qdrant install`](knowns_qdrant_install.md) — Install the pinned managed Qdrant binary with checksum verification
- [`knowns qdrant logs`](knowns_qdrant_logs.md) — Show managed Qdrant log lines
- [`knowns qdrant purge`](knowns_qdrant_purge.md) — Immediately purge positively owned semantic collections
- [`knowns qdrant start`](knowns_qdrant_start.md) — Start managed Qdrant when in managed mode
- [`knowns qdrant status`](knowns_qdrant_status.md) — Show Qdrant runtime status and paths
- [`knowns qdrant stop`](knowns_qdrant_stop.md) — Stop managed Qdrant when Knowns owns a local process

## See also

- [`knowns`](knowns.md) — The memory layer for AI-native software development

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
