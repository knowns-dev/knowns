---
title: AI Agent Quick Reference
createdAt: '2025-12-31T11:45:09.512Z'
updatedAt: '2026-01-11T08:59:19.311Z'
description: Condensed guidelines for Gemini 2.5 Flash AI agents
tags:
  - ai
  - guidelines
  - gemini
---
# AI Agent Quick Reference

Quick reference for AI agents using Knowns CLI/MCP.

## First Step

Guidelines are embedded in CLAUDE.md/AGENTS.md. Sync with:

```bash
knowns sync           # Sync with unified guidelines
knowns sync --all     # Sync all instruction files
```

## Critical Rules

| Rule | Description |
|------|-------------|
| **Never Edit .md** | Use CLI/MCP tools only |
| **Docs First** | Read docs BEFORE coding |
| **Time Tracking** | Always start/stop timer |
| **--plain Flag** | Only for view/list/search |
| **--ac not -a** | Use `--ac` for acceptance criteria |

## Flag Confusion Warning

| Flag | In `task create/edit` | In `doc edit` |
|------|----------------------|---------------|
| `-a` | Assignee | Append content |
| `--ac` | Acceptance criteria | N/A |

```bash
# ✅ Correct - add acceptance criteria
knowns task edit 42 --ac "User can login"

# ❌ Wrong - this sets assignee!
knowns task edit 42 -a "User can login"
```

## Quick Commands

### Tasks

```bash
knowns task <id> --plain              # View
knowns task list --plain              # List
knowns task edit <id> -s in-progress  # Update status
knowns task edit <id> --ac "Criterion" # Add AC
knowns task edit <id> --check-ac 1    # Check AC
knowns time start <id>                # Start timer
knowns time stop                      # Stop timer
```

### Docs

```bash
knowns doc list --plain               # List
knowns doc "path" --plain             # View
knowns search "query" --plain         # Search
```

## Task ID Format

Use raw ID only:

```bash
# ✅ Correct
knowns task create "Title" --parent 48
knowns task create "Title" --parent qkh5ne

# ❌ Wrong
knowns task create "Title" --parent task-48
```

## Status Values

`todo` | `in-progress` | `in-review` | `blocked` | `done`

## Priority Values

`low` | `medium` | `high`
