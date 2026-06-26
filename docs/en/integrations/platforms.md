# Platforms

Knowns can generate and sync different artifacts for different AI platforms via `knowns setup <target> --global` for user-level setup, or `knowns setup <target>` for repo-local setup.

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

`knowns init` creates lightweight project shims so agents can route to MCP `initial`/`help` immediately. For normal personal assistant setup, generate AI integration artifacts at user scope:

```bash
knowns setup claude --global      # Claude user-level MCP/skills/hooks
knowns setup opencode --global    # OpenCode user-level MCP/skills/hooks
knowns setup codex --global       # Codex user-level MCP/skills/hooks
knowns setup kiro --global        # Kiro user-level MCP/skills/hooks
knowns setup antigravity --global # Antigravity/Gemini global MCP config
knowns setup cursor --global      # Cursor user-level MCP config
knowns setup gemini --global      # Gemini global MCP config
knowns setup all --global         # All supported platforms at user scope
knowns setup agents               # Lightweight repo-local agent shims only
```

## Notes

- `.agents/skills` is the primary path for agent-compatible platforms
- `knowns init` creates selected lightweight instruction shims by default, such as `CLAUDE.md` and `AGENTS.md`
- use `knowns setup <target> --global` for normal personal assistant setup across repositories
- use `knowns setup <target>` only when you intentionally want project-level MCP/config files, skills, and runtime hooks
