---
title: AI Integration
createdAt: '2026-01-23T04:07:54.465Z'
updatedAt: '2026-01-23T04:08:08.973Z'
description: 'Multi-AI platform support: skills, MCP, configurations'
tags:
  - feature
  - ai
  - skills
  - mcp
---
## Overview

Knowns hỗ trợ nhiều AI platforms. Skills định nghĩa một lần trong `.knowns/skills/`, sync sang tất cả platforms.

---

## Supported Platforms

| Platform | Skills | MCP | Status |
|----------|--------|-----|--------|
| **Claude Code** | ✅ | ✅ | Full support |
| **Antigravity** | ✅ | ✅ | Full support |
| **Gemini CLI** | ✅ | ✅ | Full support |
| **Cursor** | ✅ | ✅ | Full support |
| **Cline** | ✅ | ✅ | Full support |
| **Continue** | ✅ | ✅ | Full support |
| **Windsurf** | ⚠️ | ⚠️ | Limited |
| **GitHub Copilot** | ⚠️ | ❌ | Instructions only |

---

## Architecture

```
.knowns/skills/              # Source of truth
├── knowns-task/SKILL.md
├── knowns-doc/SKILL.md
└── create-component/SKILL.md

# Auto-sync to platforms
.claude/skills/              # Claude Code
.agent/skills/               # Antigravity
.cursor/rules/               # Cursor
~/.gemini/commands/          # Gemini CLI
```

---

## Quick Start

```bash
# Init với AI platforms
knowns init --ai claude,antigravity,cursor,gemini

# Create skill
knowns skill create my-skill

# Sync to all platforms
knowns skill sync --all

# Setup MCP
knowns mcp init --all

# Check status
knowns ai status
```

---

## Documentation

| Topic | Doc |
|-------|-----|
| **Platforms** | @doc/ai/platforms |
| **Skills** | @doc/ai/skills |
| **MCP** | @doc/ai/mcp |

---

## Key Concepts

### Skills
Instructions cho AI workflows. Portable format (`SKILL.md`) giữa Claude Code và Antigravity.

### MCP (Model Context Protocol)
Cho phép AI gọi trực tiếp Knowns functions thay vì CLI commands.

### Platform Detection
```bash
knowns ai detect
```

Auto-detect AI platforms trong project và suggest next steps.
