# knowns sync

Sync project from config.json (skills, instructions, model, search index)

Apply project configuration from .knowns/config.json.

This is the recommended command after cloning a repo with Knowns:
  git clone <repo>
  knowns sync

It reads config.json and sets up everything locally:
  • Skills — copies built-in skills to platform directories
  • Instructions — generates agent instruction files (CLAUDE.md, AGENTS.md, etc.)
  • Runtime hooks — installs current memory hooks for configured runtimes
  • Model — downloads the configured embedding model (if not installed)
  • Search index — rebuilds the semantic search index
  • Git integration — applies .gitignore rules for the configured tracking mode

Use flags to sync only specific parts.

## Usage

```
knowns sync [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--force` | `bool` | — | Force resync (overwrite existing files) [deprecated: sync always overwrites] |
| `--instructions` | `bool` | — | Sync instruction files only |
| `--model` | `bool` | — | Download embedding model only |
| `--platform` | `string` | — | Sync specific platform (claude, opencode, codex, kiro, antigravity, cursor, gemini, copilot, agents, all) |
| `--skills` | `bool` | — | Sync skills only |

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
