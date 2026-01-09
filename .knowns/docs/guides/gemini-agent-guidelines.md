---
title: AI Agent Quick Reference
createdAt: '2025-12-31T11:45:09.512Z'
updatedAt: '2026-01-09T08:13:27.180Z'
description: Condensed guidelines for Gemini 2.5 Flash AI agents
tags:
  - ai
  - guidelines
  - gemini
---
# AI Agent Quick Reference

Quick reference for AI agents using Knowns CLI/MCP.

## First Step

Get the full guidelines:

```bash
# CLI
knowns agents guideline

# MCP
mcp__knowns__get_guideline({})
```

## Critical Rules

| Rule | Description |
|------|-------------|
| **Never Edit .md** | Use CLI/MCP tools only |
| **Docs First** | Read docs BEFORE coding |
| **Time Tracking** | Always start/stop timer |
| **--plain Flag** | Only for view/list/search |

## Quick Commands

### Tasks

```bash
knowns task <id> --plain              # View
knowns task list --plain              # List
knowns task edit <id> -s in-progress  # Update status
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

## Following Refs

When reading output:
- `@.knowns/tasks/task-X - ...` → `knowns task X --plain`
- `@doc/path` → `knowns doc "path" --plain`

When writing:
- Task ref: `@task-X`
- Doc ref: `@doc/path`

## For More Details

Run `knowns agents guideline` for complete guidelines.
