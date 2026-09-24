# knowns task edit

Edit a task

## Usage

```
knowns task edit <id> [flags]
```

## Examples

```bash
# Take the task
  knowns task edit KN-A1B2C3 -s in-progress -a @me

  # Record the plan before writing code
  knowns task edit KN-A1B2C3 --plan $'1. Read the spec\n2. Add the middleware\n3. Test'

  # Tick criterion 1, one-indexed, only once the work is actually done
  knowns task edit KN-A1B2C3 --check-ac 1

  # Append progress without replacing the existing notes
  knowns task edit KN-A1B2C3 --append-notes "Middleware landed, tests next"

  # Finish
  knowns task edit KN-A1B2C3 -s done
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--ac` | `stringArray` | — | Add acceptance criterion (repeatable) |
| `--append-notes` | `string` | — | Append to implementation notes |
| `-a, --assignee` | `string` | — | New assignee |
| `--check-ac` | `intSlice` | — | Check AC by 1-based index (repeatable) |
| `-d, --description` | `string` | — | New description |
| `--expected-hash` | `string` | — | Expected canonical hash for optimistic concurrency |
| `--fulfills` | `stringArray` | — | Spec ACs this task fulfills (repeatable) |
| `--labels` | `string` | — | New labels (comma-separated) |
| `--notes` | `string` | — | Set implementation notes (replaces existing) |
| `--order` | `int` | `0` | Display order (lower = first) |
| `--parent` | `string` | — | Parent task ID |
| `--plan` | `string` | — | Set implementation plan |
| `--priority` | `string` | — | New priority |
| `--remove-ac` | `intSlice` | — | Remove AC by 1-based index (repeatable) |
| `--spec` | `string` | — | Linked spec document path |
| `-s, --status` | `string` | — | New status |
| `-t, --title` | `string` | — | New title |
| `--uncheck-ac` | `intSlice` | — | Uncheck AC by 1-based index (repeatable) |

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
