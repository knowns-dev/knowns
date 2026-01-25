---
title: Claude Code Skills
createdAt: '2026-01-17T06:06:37.006Z'
updatedAt: '2026-01-17T06:15:17.546Z'
description: Pattern for creating and managing Claude Code skills in Knowns CLI
tags:
  - pattern
  - claude-code
  - skills
---
## Overview

Knowns CLI integrates with Claude Code skills - workflow templates that can be invoked via `/knowns.<skill>` commands.

## Skill Structure

```
src/templates/skills/
├── index.ts                    # Export all skills
├── knowns.task/
│   └── SKILL.md               # Skill content with frontmatter
├── knowns.task.brainstorm/
│   └── SKILL.md
├── knowns.doc/
│   └── SKILL.md
└── ...
```

## Naming Convention

- **Folder name**: `knowns.<domain>` or `knowns.<domain>.<action>`
- **Examples**: `knowns.task`, `knowns.task.brainstorm`, `knowns.doc`
- **Dot notation** creates clear hierarchy in Claude Code UI

## SKILL.md Format

```yaml
---
name: knowns.task
description: Execute Knowns task workflow
---

# Instructions

...skill content...
```

## Available Skills (8 total)

| Skill | Description |
|-------|-------------|
| `knowns.task` | Full task workflow (view, take, plan, implement, complete) |
| `knowns.task.brainstorm` | Brainstorm and create new tasks |
| `knowns.task.reopen` | Reopen completed task to add requirements |
| `knowns.task.extract` | Extract knowledge from completed tasks to docs |
| `knowns.doc` | Create and update documentation |
| `knowns.commit` | Generate commit message and commit changes |
| `knowns.init` | Initialize session (read docs, list tasks) |
| `knowns.research` | Research mode - explore without modifying |

## Sync Commands

```bash
knowns sync                   # Sync all (skills + agents)
knowns sync skills            # Sync skills only
knowns sync skills --force    # Force overwrite
knowns sync agent             # Sync agent files only
knowns sync agent --type mcp  # Use MCP guidelines
knowns sync agent --all       # Include Gemini, Copilot
```

## Implementation Details

### index.ts Pattern

```typescript
import knownsTaskMd from "./knowns.task/SKILL.md";

function createSkill(content: string, folderName: string): Skill {
  const { name, description } = parseSkillFrontmatter(content);
  return { name, folderName, description, content };
}

export const SKILL_TASK = createSkill(knownsTaskMd, "knowns.task");
```

### Sync Function

Skills are synced to `.claude/skills/<folder-name>/SKILL.md` in the project.

### Commander.js Subcommand Options

When parent command has subcommands, add `.enablePositionalOptions()` for options to be parsed correctly:

```typescript
export const syncCommand = new Command("sync")
  .enablePositionalOptions()  // Required for subcommand options
  .option("-f, --force", "Force overwrite")
  .action(...)
```

## Source Tasks

- @task-4sv3rh - Add skill sync command and change naming to dot notation
- @task-pdyd2e - Add knowns.task.reopen and knowns.task.extract skills
- @task-pqyhuh - Merge overlapping skills (13 → 8)
- @task-x4d1yw - Restructure sync commands
