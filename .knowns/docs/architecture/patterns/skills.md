---
title: Claude Code Skills
createdAt: '2026-01-17T06:06:37.006Z'
updatedAt: '2026-02-03T16:45:00.000Z'
description: Pattern for creating and managing Claude Code skills in Knowns CLI
tags:
  - pattern
  - claude-code
  - skills
---
## Overview

Knowns CLI integrates with Claude Code skills - workflow templates that can be invoked via `/kn:<skill>` commands.

## Skill Structure

```
src/instructions/skills/
├── index.ts                    # Export all skills
├── kn:init/
│   └── SKILL.md               # Skill content with frontmatter
├── kn:plan/
│   └── SKILL.md
├── kn:implement/
│   └── SKILL.md
└── ...
```

## Naming Convention

- **Folder name**: `kn:<skill>`
- **Examples**: `kn:init`, `kn:plan`, `kn:implement`
- **Colon notation** creates clear namespace in Claude Code UI

## SKILL.md Format

```yaml
---
name: kn:init
description: Initialize session with project context
---

# Instructions

...skill content...
```

## Available Skills (8 total)

| Skill | Description |
|-------|-------------|
| `kn:init` | Initialize session (read docs, list tasks) |
| `kn:plan` | Plan task implementation |
| `kn:implement` | Implement task (includes reopen logic) |
| `kn:research` | Research codebase before implementation |
| `kn:commit` | Generate commit message and commit changes |
| `kn:extract` | Extract knowledge to documentation |
| `kn:doc` | Create and update documentation |
| `kn:template` | Generate code from templates |

## Workflow

```
/kn:init → /kn:research → /kn:plan <id> → /kn:implement <id> → /kn:commit → /kn:extract <id>
```

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
import knInitMd from "./kn:init/SKILL.md";

function createSkill(content: string, folderName: string): Skill {
  const { name, description } = parseSkillFrontmatter(content);
  return { name, folderName, description, content };
}

export const SKILL_INIT = createSkill(knInitMd, "kn:init");
```

### Sync Function

Skills are synced to `.claude/skills/<folder-name>/SKILL.md` in the project.
