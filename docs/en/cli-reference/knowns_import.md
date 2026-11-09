# knowns import

Removed (imported content stays readable)

The import command and its subcommands (list, add, remove, status, sync) were removed.

Content already present in .knowns/imports/ stays readable and searchable through
'knowns doc', 'knowns template' and 'knowns search'. There is no further management
of imports: nothing adds, updates or removes them.

## Usage

```
knowns import
```

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## Subcommands

- [`knowns import add`](knowns_import_add.md) — Add an import source (removed)
- [`knowns import list`](knowns_import_list.md) — List imports (removed)
- [`knowns import remove`](knowns_import_remove.md) — Remove an import (removed)
- [`knowns import status`](knowns_import_status.md) — Show import status (removed)
- [`knowns import sync`](knowns_import_sync.md) — Sync imports (removed)

## See also

- [`knowns`](knowns.md) — The memory layer for AI-native software development

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
