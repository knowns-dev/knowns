# knowns reconcile restore

Preview or reactivate a Task or Doc whose history records a deletion

Reactivate a Task or Doc whose history head is a delete tombstone.

A Task is named by its ID and a Doc by its path. Without --execute the command
only reports what it would do. It refuses when the file on disk holds content
the tombstone did not record, so it never adopts bytes the entity did not own.

This is not "task unarchive": unarchive reopens an archived Task, restore undoes
a recorded deletion.

## Usage

```
knowns reconcile restore <task|doc> <id-or-path> [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--execute` | `bool` | — | reactivate the entity (default is preview) |

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## See also

- [`knowns reconcile`](knowns_reconcile.md) — Preview or apply canonical Task/Doc filesystem reconciliation

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
