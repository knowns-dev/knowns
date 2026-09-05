# knowns retrieve

Retrieve ranked context for docs, tasks, and memories

## Usage

```
knowns retrieve <query> [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--assignee` | `string` | — | Filter tasks by assignee |
| `--expand-references` | `bool` | — | Expand @doc/@task/@memory/@decision references into the result |
| `--include-historical` | `bool` | — | Include historical entities; Task retrieval adds done and archived Tasks |
| `--keyword` | `bool` | — | Force keyword-only retrieval |
| `--label` | `string` | — | Filter tasks by label |
| `--limit` | `int` | `20` | Limit ranked candidates |
| `--priority` | `string` | — | Filter tasks by priority |
| `--source-types` | `string` | — | Comma-separated source types: doc,task,memory,decision |
| `--status` | `string` | — | Filter by task, memory, or decision status |
| `--tag` | `string` | — | Filter docs, memories, or decisions by tag |

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
