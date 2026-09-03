# knowns memory cleanup

List stale memory cleanup candidates

## Usage

```
knowns memory cleanup [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--layer` | `string` | `project` | Memory layer (project, global; default: project) |
| `--limit` | `int` | `20` | Maximum cleanup candidates to return |
| `--older-than` | `int` | `7` | Minimum stale age in days |

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## See also

- [`knowns memory`](knowns_memory.md) — Manage memory entries

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
