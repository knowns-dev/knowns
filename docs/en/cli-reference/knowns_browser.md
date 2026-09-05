# knowns browser

Launch the Knowns web UI

Start the Knowns HTTP server and optionally open it in a browser.
Can be launched outside a repo to use the workspace picker.

## Usage

```
knowns browser [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--allow-task-hard-delete` | `bool` | — | Grant this server instance Task hard-delete capability |
| `--dev` | `bool` | — | Enable development mode (verbose logging) |
| `--no-open` | `bool` | — | Don't automatically open browser |
| `--open` | `bool` | — | Open browser after starting |
| `--password` | `string` | — | Protect WebUI with a password (in-memory only) |
| `--port` | `int` | `0` | HTTP server port (default: 6420; tries next ports if busy) |
| `--project` | `string` | — | Project path to open directly |
| `--restart` | `bool` | — | Restart server if already running |
| `--scan` | `string` | — | Comma-separated directories to scan for projects |
| `--tunnel` | `bool` | — | Expose via a Cloudflare Quick Tunnel (requires cloudflared) |
| `--watch` | `bool` | — | Enable file watcher for auto-indexing on code changes |

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## See also

- [`knowns`](knowns.md) — The memory layer for AI-native software development

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
