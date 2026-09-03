# knowns runtime memory hook

Build a runtime memory payload for adapter hooks

## Usage

```
knowns runtime memory hook [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--capture` | `string` | — | Override runtime memory capture mode |
| `--cwd` | `string` | — | Working directory for scoring context |
| `--event` | `string` | — | Hook event name |
| `--max-bytes` | `int` | `0` | Override maximum serialized bytes |
| `--max-items` | `int` | `0` | Override maximum number of memory items |
| `--mode` | `string` | — | Override runtime memory mode |
| `--project` | `string` | — | Project root (defaults to detected project) |
| `--runtime` | `string` | — | Runtime adapter name |

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## See also

- [`knowns runtime memory`](knowns_runtime_memory.md) — Manage runtime memory hook behavior

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
