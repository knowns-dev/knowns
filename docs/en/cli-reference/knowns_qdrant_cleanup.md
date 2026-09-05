# knowns qdrant cleanup

Remove stale managed Qdrant runtime metadata

Remove stale managed Qdrant PID/status metadata. This does not delete vector data or collections.

## Usage

```
knowns qdrant cleanup
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
