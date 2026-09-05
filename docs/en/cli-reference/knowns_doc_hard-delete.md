# knowns doc hard-delete

Permanently purge a document and its verified history

## Usage

```
knowns doc hard-delete <path> [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--allow-hard-delete` | `bool` | — | Grant this local invocation trusted hard-delete capability |
| `--expected-hash` | `string` | — | Expected canonical hash for optimistic concurrency |
| `--reason` | `string` | — | Required audit reason for permanent purge |
| `--yes` | `bool` | — | Confirm permanent purge |

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## See also

- [`knowns doc`](knowns_doc.md) — Manage documentation

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
