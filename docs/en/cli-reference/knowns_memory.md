# knowns memory

Manage memory entries

Create, view, and manage project and global memory entries.

## Usage

```
knowns memory
```

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## Subcommands

- [`knowns memory cleanup`](knowns_memory_cleanup.md) — List stale memory cleanup candidates
- [`knowns memory create`](knowns_memory_create.md) — Create a new memory entry
- [`knowns memory delete`](knowns_memory_delete.md) — Delete a memory entry
- [`knowns memory demote`](knowns_memory_demote.md) — Demote a memory entry down one layer
- [`knowns memory edit`](knowns_memory_edit.md) — Edit a memory entry
- [`knowns memory list`](knowns_memory_list.md) — List memory entries
- [`knowns memory promote`](knowns_memory_promote.md) — Promote a memory entry up one layer
- [`knowns memory view`](knowns_memory_view.md) — View a memory entry

## See also

- [`knowns`](knowns.md) — The memory layer for AI-native software development

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
