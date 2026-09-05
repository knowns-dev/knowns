# knowns mcp

Start the MCP (Model Context Protocol) server

Start the Knowns MCP server, which exposes project management tools
to AI agents via the Model Context Protocol.

Use --stdio to communicate over stdin/stdout (default for MCP clients).

## Usage

```
knowns mcp [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--project` | `string` | — | Project root directory (auto-detected from cwd if not set) |
| `--stdio` | `bool` | — | Use stdio transport (for MCP clients) |

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## See also

- [`knowns`](knowns.md) — The memory layer for AI-native software development

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
