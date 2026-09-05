# knowns code

Code intelligence commands

Code intelligence commands for AST-based indexing and graph analysis.

Recommended context flow:
  1. Use 'knowns code search <query>' for keyword code discovery across LSP symbols.
  2. Use 'knowns code symbols' to verify what was actually indexed in a file or scope.
  3. Use 'knowns code deps' to inspect raw relationships such as calls, imports, ownership, and inheritance.

Examples:
  knowns code search "login auth"
  knowns code search "handleCodeDefinition" --path internal/mcp
  knowns code deps --type calls
  knowns code symbols --kind function

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## Subcommands

- [`knowns code deps`](knowns_code_deps.md) — Inspect code dependency data
- [`knowns code search`](knowns_code_search.md) — Keyword search across LSP code symbols
- [`knowns code symbols`](knowns_code_symbols.md) — Inspect indexed code symbols

## See also

- [`knowns`](knowns.md) — The memory layer for AI-native software development

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
