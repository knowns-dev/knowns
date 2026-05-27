# Platforms

Knowns generate và sync artifacts khác nhau cho từng AI platform qua `knowns setup <target>`.

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

## Mapping

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

AI integration files được tạo qua `knowns setup`, không phải trong `knowns init`:

```bash
knowns setup claude    # CLAUDE.md, .mcp.json, skills, hooks
knowns setup opencode  # OPENCODE.md, opencode.json, skills, hooks
knowns setup kiro      # .kiro steering/settings, skills, hooks
knowns setup copilot   # .github/copilot-instructions.md
knowns setup all       # Tất cả platforms
```

## Ghi chú

- `.agents/skills` là primary path cho agent-compatible platforms
- `knowns init` không còn generate AI integration files — dùng `knowns setup` sau init
