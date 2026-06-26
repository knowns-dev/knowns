# Platforms

Knowns generate và sync artifacts khác nhau cho từng AI platform qua `knowns setup <target> --global` cho user-level setup, hoặc `knowns setup <target>` cho repo-local setup.

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

`knowns init` tạo lightweight project shims để agent route tới MCP `initial`/`help` ngay. Với personal assistant setup thông thường, tạo AI integration artifacts ở user scope:

```bash
knowns setup claude --global      # Claude user-level MCP/skills/hooks
knowns setup opencode --global    # OpenCode user-level MCP/skills/hooks
knowns setup codex --global       # Codex user-level MCP/skills/hooks
knowns setup kiro --global        # Kiro user-level MCP/skills/hooks
knowns setup antigravity --global # Antigravity/Gemini global MCP config
knowns setup cursor --global      # Cursor user-level MCP config
knowns setup gemini --global      # Gemini global MCP config
knowns setup all --global         # Tất cả platforms ở user scope
knowns setup agents               # chỉ lightweight repo-local agent shims
```

## Ghi chú

- `.agents/skills` là primary path cho agent-compatible platforms
- `knowns init` tạo selected lightweight instruction shims mặc định, như `CLAUDE.md` và `AGENTS.md`
- dùng `knowns setup <target> --global` cho personal assistant setup thông thường trên nhiều repository
- chỉ dùng `knowns setup <target>` khi bạn chủ ý muốn project-level MCP/config files, skills, runtime hooks
