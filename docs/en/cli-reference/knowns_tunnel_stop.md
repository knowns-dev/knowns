# knowns tunnel stop

Stop the cloudflared tunnel for a port

## Usage

```
knowns tunnel stop [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--port` | `int` | `6420` | Local port the tunnel targets |

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## See also

- [`knowns tunnel`](knowns_tunnel.md) — Manage Cloudflare Quick Tunnels for the local server

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
