# knowns task assignees

Count tasks per assignee

Count tasks per assignee, broken down by status. Tasks with no assignee
are counted in a final unassigned bucket. Takes the same filters as "task list".

Assignees match exactly and case-sensitively after trimming spaces (@Alice is
not @alice), "@me" is not resolved and is matched literally, and a task holds
one assignee string, so "@a, @b" is a single bucket.

## Usage

```
knowns task assignees [flags]
```

## Examples

```bash
# Who holds how much work, by status
  knowns task assignees

  # Only what is in flight
  knowns task assignees --status in-progress

  # Parseable output for an agent
  knowns task assignees --json
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--assignee` | `string` | — | Filter by assignee |
| `--include-historical` | `bool` | — | Include historical entities, including archived Tasks |
| `--label` | `string` | — | Filter by label |
| `--priority` | `string` | — | Filter by priority |
| `--status` | `string` | — | Filter by status |
| `--unassigned` | `bool` | — | Only tasks with no assignee |

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
