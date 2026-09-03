# knowns lsp install

Install an LSP language server

## Usage

```
knowns lsp install <language> [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--latest` | `bool` | — | Install the latest upstream version (requires confirmation) |
| `--version` | `string` | — | Install an explicit upstream version or tag (requires confirmation) |
| `-y, --yes` | `bool` | — | Confirm a non-recommended version selection |

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## See also

- [`knowns lsp`](knowns_lsp.md) — Manage LSP language servers

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
