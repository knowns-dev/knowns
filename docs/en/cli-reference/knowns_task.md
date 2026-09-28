# knowns task

Manage tasks

Create, view, edit, and manage project tasks.

## Usage

```
knowns task [id]
```

## Examples

```bash
# The everyday loop
  knowns task list
  knowns task create "Add JWT auth"
  knowns task edit KN-A1B2C3 -s in-progress
  knowns task edit KN-A1B2C3 -s done

  # Read one task; the id alone is shorthand for "task view"
  knowns task KN-A1B2C3
```

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## Subcommands

- [`knowns task archive`](knowns_task_archive.md) — Archive a task
- [`knowns task batch-archive`](knowns_task_batch-archive.md) — Preview or execute a batch archive
- [`knowns task batch-unarchive`](knowns_task_batch-unarchive.md) — Preview or execute a batch unarchive
- [`knowns task create`](knowns_task_create.md) — Create a new task
- [`knowns task edit`](knowns_task_edit.md) — Edit a task
- [`knowns task hard-delete`](knowns_task_hard-delete.md) — Permanently delete a task and retain a content-free tombstone
- [`knowns task history`](knowns_task_history.md) — Show version history of a task
- [`knowns task list`](knowns_task_list.md) — List tasks
- [`knowns task unarchive`](knowns_task_unarchive.md) — Restore a task from the archive
- [`knowns task view`](knowns_task_view.md) — View a task

## See also

- [`knowns`](knowns.md) — The memory layer for AI-native software development

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
