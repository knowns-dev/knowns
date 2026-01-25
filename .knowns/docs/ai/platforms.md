---
title: AI Platforms
createdAt: '2026-01-23T04:07:55.100Z'
updatedAt: '2026-01-23T04:08:23.052Z'
description: 'Configuration for Claude Code, Antigravity, Cursor, Gemini CLI'
tags:
  - feature
  - ai
  - platforms
---
## Overview

Cấu hình cho từng AI platform.

**Related:** @doc/ai/mcp, @doc/ai/skills

---

## Claude Code

### Structure
```
.claude/
├── CLAUDE.md              # Instructions
├── settings.json
└── skills/
    └── knowns-task/SKILL.md
```

### MCP: `.mcp.json`
```json
{
  "mcpServers": {
    "knowns": {
      "command": "npx",
      "args": ["-y", "knowns", "mcp"]
    }
  }
}
```

---

## Google Antigravity

### Structure
```
.agent/
├── skills/                # SKILL.md (same as Claude\!)
├── rules/
└── workflows/

~/.gemini/antigravity/skills/  # Global
```

### MCP: `.agent/settings.json`
```json
{
  "mcp": {
    "servers": {
      "knowns": {
        "command": "npx",
        "args": ["-y", "knowns", "mcp"]
      }
    }
  }
}
```

> **Portable:** Claude Code ↔ Antigravity dùng cùng SKILL.md format

---

## Gemini CLI

### Structure
```
project/
├── GEMINI.md              # Project instructions

~/.gemini/
├── settings.json          # MCP config
└── commands/              # Custom /commands
```

### MCP: `~/.gemini/settings.json`
```json
{
  "mcpServers": {
    "knowns": {
      "command": "npx",
      "args": ["-y", "knowns", "mcp"]
    }
  }
}
```

---

## Cursor

### Structure
```
.cursor/
├── rules/
│   └── knowns.mdc
└── mcp.json
```

### .mdc Format
```markdown
---
description: "Knowns integration"
alwaysApply: true
globs: ["**/*.ts"]
---

Rule content...
```

### Rule Types
| Type | Trigger |
|------|---------|
| Always Apply | Every chat |
| Apply Intelligently | AI decides |
| Apply to Specific Files | Glob match |
| Apply Manually | @mention |

---

## Other Platforms

### Windsurf
`.windsurfrules` - Single file, inline instructions

### Cline
`.clinerules/` - Markdown files

### Continue
`.continue/config.json` - Custom commands

### GitHub Copilot
`.github/copilot-instructions.md` - No MCP

---

## Comparison

| Platform | Skills Location | Format | MCP Config |
|----------|-----------------|--------|------------|
| Claude Code | `.claude/skills/` | SKILL.md | `.mcp.json` |
| Antigravity | `.agent/skills/` | SKILL.md | `.agent/settings.json` |
| Gemini CLI | `~/.gemini/commands/` | .md | `~/.gemini/settings.json` |
| Cursor | `.cursor/rules/` | .mdc | `.cursor/mcp.json` |
