# knowns config

Manage project configuration

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## Subcommands

- [`knowns config get`](knowns_config_get.md) — Get a config value
- [`knowns config list`](knowns_config_list.md) — List all config settings
- [`knowns config reset`](knowns_config_reset.md) — Reset config to defaults
- [`knowns config set`](knowns_config_set.md) — Set a config value

## See also

- [`knowns`](knowns.md) — The memory layer for AI-native software development

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
