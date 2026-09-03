# knowns doc

Manage documentation

Create, view, and edit project documentation.

## Usage

```
knowns doc [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--info` | `bool` | — | Show document stats without content |
| `--line` | `string` | — | Show specific lines (e.g., '42' or '10-20') |
| `--section` | `string` | — | Show specific section by number or title |
| `--smart` | `bool` | — | Auto-optimize reading for large documents |
| `--toc` | `bool` | — | Show table of contents only |

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## Subcommands

- [`knowns doc create`](knowns_doc_create.md) — Create a new documentation file
- [`knowns doc delete`](knowns_doc_delete.md) — Delete a document permanently
- [`knowns doc edit`](knowns_doc_edit.md) — Edit a documentation file
- [`knowns doc hard-delete`](knowns_doc_hard-delete.md) — Permanently purge a document and its verified history
- [`knowns doc history`](knowns_doc_history.md) — Show version history of a document
- [`knowns doc list`](knowns_doc_list.md) — List all documentation files
- [`knowns doc view`](knowns_doc_view.md) — View a documentation file

## See also

- [`knowns`](knowns.md) — The memory layer for AI-native software development

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
