# knowns tunnel

Manage Cloudflare Quick Tunnels for the local server

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## Subcommands

- [`knowns tunnel status`](knowns_tunnel_status.md) — Show the current tunnel URL for a port
- [`knowns tunnel stop`](knowns_tunnel_stop.md) — Stop the cloudflared tunnel for a port

## See also

- [`knowns`](knowns.md) — The memory layer for AI-native software development

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
