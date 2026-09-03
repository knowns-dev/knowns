# knowns resolve

Resolve a semantic reference

## Usage

```
knowns resolve <semantic-ref> [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--depth` | `int` | `0` | Max traversal hops (1-3, default 1) |
| `--direction` | `string` | — | Traversal direction: outbound (default), inbound, or both |
| `--relation` | `string` | — | Filter by relation kinds (comma-separated) |
| `--type` | `string` | — | Filter result entities by kind (comma-separated) |

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
