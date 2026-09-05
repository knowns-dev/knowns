# knowns qdrant logs

Show managed Qdrant log lines

## Usage

```
knowns qdrant logs [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `-n, --tail` | `int` | `50` | Number of trailing lines to show |

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
