# knowns provider

Manage embedding API providers

Register, list, remove, and test OpenAI-compatible embedding API providers.

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## Subcommands

- [`knowns provider add`](knowns_provider_add.md) — Register a new embedding provider
- [`knowns provider list`](knowns_provider_list.md) — List registered providers
- [`knowns provider remove`](knowns_provider_remove.md) — Remove a provider
- [`knowns provider test`](knowns_provider_test.md) — Health-check a provider

## See also

- [`knowns`](knowns.md) — The memory layer for AI-native software development

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
