# knowns lsp

Manage LSP language servers

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## Subcommands

- [`knowns lsp cleanup`](knowns_lsp_cleanup.md) — Remove old LSP server versions
- [`knowns lsp install`](knowns_lsp_install.md) — Install an LSP language server
- [`knowns lsp list`](knowns_lsp_list.md) — List supported LSP language servers

## See also

- [`knowns`](knowns.md) — The memory layer for AI-native software development

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
