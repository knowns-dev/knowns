# knowns code deps

Inspect code dependency data

## Usage

```
knowns code deps [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--limit` | `int` | `200` | Limit dependency results |
| `--type` | `string` | — | Filter dependency edges by type |

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## See also

- [`knowns code`](knowns_code.md) — Code intelligence commands

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
