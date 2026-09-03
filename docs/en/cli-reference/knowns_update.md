# knowns update

Update Knowns CLI to the latest version and sync project configs

Update the Knowns CLI binary to the latest version, then sync the current
project's MCP configurations to use the local binary directly (instead of npx).

This command:
  1. Detects how Knowns was installed (Homebrew, npm, etc.)
  2. Runs the appropriate upgrade command
  3. Syncs MCP configs (.mcp.json, .kiro/settings/mcp.json) to use the local binary

Use --check to only check for updates without installing.

## Usage

```
knowns update [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--check` | `bool` | — | Only check for updates without installing |

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
