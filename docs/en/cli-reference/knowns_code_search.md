# knowns code search

Keyword search across LSP code symbols

## Usage

```
knowns code search <query> [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--limit` | `int` | `20` | Limit search results |
| `--path` | `string` | — | Search within a specific file or directory |

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## See also

- [`knowns code`](knowns_code.md) — Code intelligence commands

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
