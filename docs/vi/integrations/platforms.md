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

`knowns init` tạo project guidance files để agent đọc rule của repo ngay. AI integration artifacts được tạo qua `knowns setup`:

```bash
knowns setup claude    # CLAUDE.md, .mcp.json, skills, hooks
knowns setup opencode  # OPENCODE.md, opencode.json, skills, hooks
knowns setup codex     # AGENTS.md, .codex/config.toml, skills, hooks
knowns setup kiro      # .kiro steering/settings, skills, hooks
knowns setup copilot   # .github/copilot-instructions.md
knowns setup agents    # chỉ KNOWNS.md + AGENTS.md
knowns setup all       # Tất cả platforms
```

## Ghi chú

- `.agents/skills` là primary path cho agent-compatible platforms
- `knowns init` tạo selected instruction shims mặc định (`KNOWNS.md`, `CLAUDE.md`, `AGENTS.md`)
- dùng `knowns setup <target>` cho project-level MCP/config files, skills, runtime hooks
- dùng `knowns setup codex --global` khi Codex integration chỉ nên nằm ở user scope
