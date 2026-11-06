---
id: doc-b9a1d72978b69c243b184edb3e763e4a
title: AI Integration
description: 'Multi-AI platform support: skills, MCP, configurations'
createdAt: '2026-01-23T04:07:54.465Z'
updatedAt: '2026-04-24T14:35:58.809Z'
tags: []
---

## Overview

Knowns supports multiple AI platforms. Skills are defined once in `.knowns/skills/`, synced to all platforms.

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
.agents/skills/              # Codex / OpenCode / Antigravity
.kiro/skills/                # Kiro
~/.gemini/commands/          # Gemini CLI
```

---

## Quick Start

```bash
# Init with AI platforms
knowns init

# Sync skills + instructions to platform dirs
knowns sync

# Setup MCP (auto-configures for installed binary)
knowns mcp setup
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
Instructions for AI workflows. Portable format (`SKILL.md`) across compatible platforms, with Knowns syncing them into the platform-specific skill directories each runtime discovers.

### MCP (Model Context Protocol)
Allows AI to call Knowns functions directly instead of CLI commands.
