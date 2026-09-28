# knowns task list

List tasks

## Usage

```
knowns task list [flags]
```

## Examples

```bash
# Every task
  knowns task list

  # Only what is being worked on
  knowns task list --status in-progress

  # Your own high-priority work
  knowns task list --assignee @me --priority high

  # As a parent/child tree
  knowns task list --tree
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--assignee` | `string` | — | Filter by assignee |
| `--include-historical` | `bool` | — | Include historical entities, including archived Tasks |
| `--label` | `string` | — | Filter by label |
| `--priority` | `string` | — | Filter by priority |
| `--status` | `string` | — | Filter by status |
| `--tree` | `bool` | — | Show tasks as tree hierarchy |

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## See also

- [`knowns task`](knowns_task.md) — Manage tasks

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
