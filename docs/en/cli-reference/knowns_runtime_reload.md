# knowns runtime reload

Reload shared runtime semantic providers and config

## Usage

```
knowns runtime reload [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--timeout` | `duration` | `10s` | Maximum time to wait for reload acknowledgement |
| `--wait` | `bool` | — | Wait until runtime acknowledges reload |

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## See also

- [`knowns runtime`](knowns_runtime.md) — Install and inspect runtime hooks and status integrations

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
