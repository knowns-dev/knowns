# knowns search

Search tasks and documentation

## Usage

```
knowns search <query> [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--assignee` | `string` | — | Filter tasks by assignee |
| `--include-historical` | `bool` | — | Include historical entities, including archived Tasks |
| `--keyword` | `bool` | — | Force keyword-only search |
| `--label` | `string` | — | Filter tasks by label |
| `--limit` | `int` | `20` | Limit search results |
| `--priority` | `string` | — | Filter tasks by priority |
| `--reindex` | `bool` | — | Rebuild the search index |
| `--setup` | `bool` | — | Set up semantic search |
| `--status` | `string` | — | Filter by task, memory, or decision status |
| `--status-check` | `bool` | — | Show semantic search status |
| `--tag` | `string` | — | Filter docs, memories, or decisions by tag |
| `--type` | `string` | — | Search type: all\|task\|doc\|memory\|decision (default: all) |

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## Subcommands

- [`knowns search index`](knowns_search_index.md) — Build the configured semantic index

## See also

- [`knowns`](knowns.md) — The memory layer for AI-native software development

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
