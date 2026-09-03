# knowns setup

Configure AI tool integrations

Configure AI tool integrations for an initialized Knowns project.

Without a target, an interactive selector is shown.

Targets:
  claude    Generate CLAUDE.md, .mcp.json, skills, and runtime hooks
  opencode  Generate OPENCODE.md, opencode.json, skills, and runtime hooks
  hermes    Generate AGENTS.md, skills, and a project-pinned global Hermes MCP config
  codex     Generate AGENTS.md, .codex/config.toml, skills, and runtime hooks
  copilot   Generate .github/copilot-instructions.md
  kiro      Generate .kiro steering/settings, skills, and runtime hooks
  cursor    Generate .cursor/mcp.json
  gemini    Generate GEMINI.md
  antigravity Generate Antigravity rules/config and skills
  agents    Generate AGENTS.md
  all       Generate all supported AI integration files

Use --global to install at user-level paths (no project required).
Global MCP uses 'knowns mcp --stdio' without --project flag.

## Usage

```
knowns setup [target] [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `-f, --force` | `bool` | — | Overwrite generated files where supported |
| `--global` | `bool` | — | Install to user-level paths (no project required) |

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
