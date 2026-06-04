# Platforms

Knowns can generate and sync different artifacts for different AI platforms via `knowns setup <target>`.

## Platform IDs

- `claude-code`
- `opencode`
- `codex`
- `kiro`
- `antigravity`
- `cursor`
- `gemini`
- `copilot`
- `agents`

## Current mapping

| Platform | Skills | MCP/config | Runtime hooks |
|---|---|---|---|
| Claude Code | `.claude/skills` | `.mcp.json` | yes |
| OpenCode | `.agents/skills` | `opencode.json` | plugin/runtime |
| Codex | `.agents/skills` | `.codex/config.toml` | hooks |
| Kiro | `.kiro/skills` | `.kiro/settings/mcp.json` | hooks |
| Antigravity | `.agents/skills` | `~/.gemini/antigravity/mcp_config.json` | rules + global config |
| Cursor | none by default | `.cursor/mcp.json` | no |
| Gemini CLI | none by default | platform-managed/global | no |
| GitHub Copilot | instruction only | no | no |
| Generic agents | `.agents/skills` | no | no |

## Setup

`knowns init` creates project guidance files so agents can read repo rules immediately. AI integration artifacts are generated via `knowns setup`:

```bash
knowns setup claude    # CLAUDE.md, .mcp.json, skills, hooks
knowns setup opencode  # OPENCODE.md, opencode.json, skills, hooks
knowns setup codex     # AGENTS.md, .codex/config.toml, skills, hooks
knowns setup kiro      # .kiro steering/settings, skills, hooks
knowns setup copilot   # .github/copilot-instructions.md
knowns setup agents    # KNOWNS.md + AGENTS.md only
knowns setup all       # All supported platforms
```

## Notes

- `.agents/skills` is the primary path for agent-compatible platforms
- `knowns init` creates selected instruction shims by default (`KNOWNS.md`, `CLAUDE.md`, `AGENTS.md`)
- use `knowns setup <target>` for project-level MCP/config files, skills, and runtime hooks
- use `knowns setup codex --global` when Codex integration should live only at user scope
