# knowns store status

Show sync state for every repository linked to a store

Show, for every repository linked to a knowledge store on this machine, the
store and project folder, the last push and fetch, commits waiting to be pushed,
and whether sync is healthy or paused and why.

## Usage

```
knowns store status
```

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## See also

- [`knowns store`](knowns_store.md) — Keep project knowledge in a shared Git store instead of the repository

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
