# knowns qdrant purge

Immediately purge positively owned semantic collections

Explicit privacy/hard purge. Retention is bypassed, but deletion fails closed unless pointer and generation history prove ownership.

## Usage

```
knowns qdrant purge
```

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## See also

- [`knowns qdrant`](knowns_qdrant.md) — Inspect and control the semantic Qdrant runtime

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
