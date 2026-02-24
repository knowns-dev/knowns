---
title: Init Process
createdAt: '2026-01-23T04:13:12.738Z'
updatedAt: '2026-02-24T07:31:50.449Z'
description: Detailed init wizard flow and configuration steps
tags:
  - feature
  - init
  - wizard
---
## Overview

`knowns init` is a wizard to setup Knowns in a project. This doc describes each step in detail.

---

## Quick Start

```bash
# Interactive (full wizard)
knowns init

# Quick init with defaults
knowns init my-project --no-wizard

# Specific AI platforms
knowns init --ai claude,antigravity,cursor
```

---

## Wizard Flow

```
┌─────────────────────────────────────────────────────────┐
│                  knowns init                            │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│ Step 1: Project Info                                    │
│ • Project name                                          │
│ • Default assignee                                      │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│ Step 2: Git Tracking                                    │
│ • git-tracked / git-ignored / none                      │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│ Step 3: AI Platforms                                    │
│ • Select platforms (Claude, Antigravity, Cursor, etc.)  │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│ Step 4: Skill Mode                                      │
│ • MCP / CLI / Hybrid                                    │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│ Step 5: Generate Files                                  │
│ • .knowns/ folder                                       │
│ • AI platform configs                                   │
│ • MCP configs                                           │
│ • Skills                                                │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│ Done! Show next steps                                   │
└─────────────────────────────────────────────────────────┘
```

---

## Step 1: Project Info

```bash
🚀 Knowns Project Setup Wizard

? Project name: (my-project)
  # Default: folder name

? Default assignee: (@me)
  # Used for task assignment
  # Can be GitHub username, email, or @me
```

**Generated:**
```json
// .knowns/config.json
{
  "name": "my-project",
  "defaultAssignee": "@me"
}
```

---

## Step 2: Git Tracking Mode

```bash
? Git tracking mode:
  ◉ Git Tracked (recommended for teams)
    → All .knowns/ files tracked in git
    
  ◯ Git Ignored (personal use)
    → Only docs tracked, tasks/config ignored
    
  ◯ None (ignore all)
    → Entire .knowns/ folder ignored
```

**Generated:**

| Mode | .gitignore |
|------|------------|
| `git-tracked` | (nothing added) |
| `git-ignored` | `.knowns/*` + `!.knowns/docs/` |
| `none` | `.knowns/` |

---

## Step 3: AI Platforms (Auto-Configured)

**As of v0.11.3+**, AI platforms are auto-configured without selection.

All major platforms are initialized automatically:

| Platform | Files Created |
|----------|---------------|
| Claude Code | `.claude/skills/`, `.mcp.json`, `CLAUDE.md` |
| Antigravity | `.agent/skills/`, `~/.gemini/antigravity/mcp_config.json`, `GEMINI.md` |
| GitHub Copilot | `.github/copilot-instructions.md` |
| Generic | `AGENTS.md` |

**Why auto-configure?**
- Reduces wizard friction
- Most users want all major platforms
- Version tracking enables auto-sync later

**Version tracking:**
After init, each platform directory has `.version`:
```
.claude/skills/.version
.agent/skills/.version
```

This enables auto-sync when CLI is upgraded. See @doc/architecture/patterns/auto-sync-version-tracking

---
## Step 4: Skill Mode

```bash
? Skill instruction mode:
  ◉ MCP (recommended)
    → Use MCP tools (mcp__knowns__*)
    → Faster, structured JSON output
    → Full feature support
    
  ◯ CLI
    → Use CLI commands (knowns task/doc/...)
    → Works everywhere
    → Traditional approach
    
  ◯ Hybrid
    → MCP for reading (faster)
    → CLI for writing (familiar)
```

**Impact on generated skills:**

| Mode | Skill Content |
|------|---------------|
| MCP | `mcp__knowns__get_task(...)`, `mcp__knowns__update_task(...)` |
| CLI | `knowns task <id> --plain`, `knowns task edit <id> -s ...` |
| Hybrid | MCP for reads, CLI for writes |

---

## Step 5: Generate Files

### 5.1 Core Structure

```
.knowns/
├── config.json              # Project config
├── tasks/                   # Task files
├── docs/                    # Documentation
├── skills/                  # Skill source (new!)
│   ├── knowns-task/SKILL.md
│   ├── knowns-doc/SKILL.md
│   └── knowns-commit/SKILL.md
└── templates/               # Code templates (empty)
```

### 5.2 AI Platform Files

**Claude Code:**
```
.claude/
├── CLAUDE.md                # Instructions (with guidelines)
├── settings.json
└── skills/                  # Synced from .knowns/skills/
    ├── knowns-task/SKILL.md
    └── ...

.mcp.json                    # MCP config
```

**Antigravity:**
```
.agent/
├── skills/                  # Synced from .knowns/skills/
├── rules/
│   └── knowns.md
└── settings.json            # MCP config
```

**Gemini CLI:**
```
GEMINI.md                    # Project instructions

~/.gemini/settings.json      # MCP config (updated)
~/.gemini/commands/          # Synced skills
```

**Cursor:**
```
.cursor/
├── rules/
│   ├── knowns.mdc           # Main rules
│   └── knowns-task.mdc      # Task workflow
└── mcp.json                 # MCP config
```

### 5.3 MCP Configuration

Automatically creates MCP config for each selected platform.

---

## Complete Example

```bash
$ knowns init

🚀 Knowns Project Setup Wizard

? Project name: my-awesome-app
? Default assignee: @johndoe

? Git tracking mode: Git Tracked (recommended)

? Select AI platforms:
  ◉ Claude Code
  ◉ Google Antigravity
  ◉ Cursor
  ◯ Others...

? Skill instruction mode: MCP (recommended)

Creating project structure...

✓ Created .knowns/config.json
✓ Created .knowns/tasks/
✓ Created .knowns/docs/
✓ Created .knowns/skills/ (8 built-in skills)
✓ Created .knowns/templates/

Setting up AI platforms...

✓ Claude Code
  • Created .claude/CLAUDE.md
  • Created .claude/skills/ (8 skills)
  • Created .mcp.json

✓ Google Antigravity
  • Created .agent/skills/ (8 skills)
  • Created .agent/rules/knowns.md
  • Created .agent/settings.json (MCP)

✓ Cursor
  • Created .cursor/rules/knowns.mdc
  • Created .cursor/mcp.json

───────────────────────────────────────

✅ Project initialized: my-awesome-app

Next steps:
  1. Create your first task:
     knowns task create "My first task"
  
  2. View available skills:
     knowns skill list
  
  3. Start working with AI:
     Open project in Claude Code / Antigravity / Cursor

Documentation:
  knowns doc "guides/user-guide" --plain
```

---

## CLI Options

```bash
# Full wizard
knowns init

# Skip wizard, use defaults
knowns init my-project --no-wizard

# Specify AI platforms
knowns init --ai claude,antigravity,cursor

# Specify all options
knowns init my-project \
  --ai claude,antigravity \
  --skill-mode mcp \
  --git-mode git-tracked \
  --assignee @johndoe

# Force reinitialize
knowns init --force

# Dry run (preview only)
knowns init --dry-run
```

---

## Config Output

```json
// .knowns/config.json
{
  "name": "my-awesome-app",
  "version": "1.0.0",
  "defaultAssignee": "@johndoe",
  "defaultPriority": "medium",
  "gitTrackingMode": "git-tracked",
  
  "ai": {
    "platforms": ["claude", "antigravity", "cursor"],
    "skillMode": "mcp"
  },
  
  "skills": {
    "source": ".knowns/skills/",
    "mode": "mcp",
    "builtIn": [
      "knowns-task",
      "knowns-doc", 
      "knowns-commit",
      "knowns-init",
      "knowns-research"
    ]
  },
  
  "mcp": {
    "enabled": true
  }
}
```

---

## Post-Init Commands

```bash
# Check what was created
knowns status

# List skills
knowns skill list

# Sync skills if needed
knowns skill sync --all
```

---

## Updating Configuration

```bash
# Change skill mode
knowns config set skills.mode cli

# Sync skills after config change
knowns skill sync --all

# Re-run init to add new platforms
knowns init --force
```
