# knowns import status

Show import status (removed)

The import command and its subcommands (list, add, remove, status, sync) were removed.

Content already present in .knowns/imports/ stays readable and searchable through
'knowns doc', 'knowns template' and 'knowns search'. There is no further management
of imports: nothing adds, updates or removes them.

## Usage

```
knowns import status
```

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## See also

- [`knowns import`](knowns_import.md) — Removed (imported content stays readable)

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
