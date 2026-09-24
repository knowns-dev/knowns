# knowns task create

Create a new task

## Usage

```
knowns task create <title> [flags]
```

## Examples

```bash
# A task with nothing but a title
  knowns task create "Add JWT auth"

  # With outcome-oriented acceptance criteria, repeat --ac per criterion
  knowns task create "Add JWT auth" \
    --ac "User can log in and receive a token" \
    --ac "Expired tokens are rejected"

  # With priority and labels
  knowns task create "Fix login timeout" --priority high -l auth,bug

  # As a subtask of an existing task
  knowns task create "Write auth tests" --parent KN-A1B2C3
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--ac` | `stringArray` | — | Acceptance criterion (repeatable) |
| `-a, --assignee` | `string` | — | Task assignee |
| `-d, --description` | `string` | — | Task description |
| `--fulfills` | `stringArray` | — | Spec AC this task fulfills (repeatable) |
| `-l, --label` | `stringArray` | — | Task label (repeatable) |
| `--notes` | `string` | — | Implementation notes |
| `--parent` | `string` | — | Parent task ID |
| `--plan` | `string` | — | Implementation plan |
| `--prefix` | `string` | — | Custom task ID prefix (2-8 alphanumeric characters) |
| `--priority` | `string` | — | Task priority (low\|medium\|high) |
| `--spec` | `string` | — | Linked spec document path |
| `-s, --status` | `string` | — | Task status |

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
