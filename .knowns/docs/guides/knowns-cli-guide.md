---
title: Knowns CLI Guide
createdAt: '2025-12-26T19:43:25.470Z'
updatedAt: '2026-01-08T20:50:16.456Z'
description: Complete guide for using Knowns CLI
tags:
  - guide
  - cli
  - tutorial
---
# Knowns CLI Guide

Knowns is a CLI tool for managing tasks, documentation, and time tracking for development teams.

## Installation

```bash
# Clone and build
git clone <repo>
cd knowns
bun install
bun run build

# Or install globally
bun link
```

## Initialize Project

```bash
knowns init [project-name]
```

This creates a `.knowns/` directory containing:
- `tasks/` - Task files
- `docs/` - Documentation files  
- `config.json` - Project configuration

---

## Task Management

### Create Task

```bash
knowns task create "Title" -d "Description" --ac "Criterion 1" --ac "Criterion 2"
```

**Options:**
- `-d, --description` - Task description
- `--ac` - Acceptance criteria (can be used multiple times)
- `-l, --labels` - Labels (comma-separated)
- `--priority` - low | medium | high
- `-p, --parent` - Parent task ID

### View Task

```bash
knowns task view <id> --plain
```

### List Tasks

```bash
knowns task list --plain
knowns task list --status in-progress --plain
knowns task list --assignee @me --plain
knowns task list --tree --plain  # Show tree hierarchy
```

### Edit Task

```bash
# Metadata
knowns task edit <id> -t "New title"
knowns task edit <id> -s in-progress -a @me

# Acceptance Criteria
knowns task edit <id> --ac "New criterion"      # Add
knowns task edit <id> --check-ac 1              # Check (1-indexed)
knowns task edit <id> --uncheck-ac 1            # Uncheck

# Plan & Notes  
knowns task edit <id> --plan "1. Step 1\n2. Step 2"
knowns task edit <id> --notes "Implementation summary"
knowns task edit <id> --append-notes "Progress update"
```

---

## Documentation

### Create Doc

```bash
knowns doc create "Title" -d "Description" -t "tags" -f "folder/path"
```

### View Doc

```bash
knowns doc view "doc-name" --plain
knowns doc view "folder/doc-name" --plain
```

### Edit Doc

```bash
# Metadata
knowns doc edit "doc-name" -t "New Title" --tags "new,tags"

# Content
knowns doc edit "doc-name" -c "New content"
knowns doc edit "doc-name" -a "Appended content"
```

### List Docs

```bash
knowns doc list --plain
knowns doc list --tag guide --plain
```

---

## Time Tracking

### Timer

```bash
knowns time start <task-id>
knowns time stop
knowns time pause
knowns time resume
knowns time status
```

### Manual Entry

```bash
knowns time add <task-id> 2h -n "Note" -d "2025-12-25"
```

### Reports

```bash
knowns time report --from "2025-12-01" --to "2025-12-31"
knowns time report --by-label --csv > report.csv
```

---

## Search

```bash
knowns search "query" --plain
knowns search "auth" --type task --plain
knowns search "patterns" --type doc --plain
knowns search "bug" --status in-progress --priority high --plain
```

---

## Reference System

Tasks and docs can contain references to each other:

| Type | Format | Output |
|------|--------|--------|
| Task | `@task-<id>` | `@.knowns/tasks/task-<id> - <title>.md` |
| Doc | `@doc/<path>` | `@.knowns/docs/<path>.md` |

**Example:**
```
See @task-42 for implementation details.
Follow patterns in @doc/patterns/module.md
```

---

## Status Values

| Status | Description |
|--------|-------------|
| `todo` | Not started |
| `in-progress` | Currently working |
| `in-review` | In code review |
| `blocked` | Waiting on dependency |
| `done` | Completed |

## Priority Values

| Priority | Description |
|----------|-------------|
| `low` | Can wait, nice-to-have |
| `medium` | Normal priority (default) |
| `high` | Urgent, time-sensitive |

---

## Tips

1. **Always use `--plain`** when working with AI agents
2. **Read docs first** before starting a new task
3. **Track time** for accurate reports
4. **Use references** (`@task-X`, `@doc/path`) to link related items
5. **Follow refs recursively** - refs may contain nested refs

---

## AI Agent Instructions

### Interactive Mode

```bash
knowns agents
```

Prompts for:
1. Guidelines type (CLI or MCP)
2. Variant (General or Gemini compact)
3. Files to update

### Quick Sync

```bash
# Sync CLAUDE.md and AGENTS.md with CLI guidelines
knowns agents sync

# Sync all files (including GEMINI.md, Copilot)
knowns agents sync --all

# Use compact Gemini variant
knowns agents sync --gemini

# MCP guidelines
knowns agents sync --type mcp

# Combine options
knowns agents sync --type mcp --gemini --all
```

### Non-Interactive Update

```bash
knowns agents --update-instructions
knowns agents --update-instructions --gemini
knowns agents --update-instructions --type mcp --files "CLAUDE.md,AGENTS.md"
```

### Supported Files

| File | Description |
|------|-------------|
| CLAUDE.md | Claude Code instructions |
| AGENTS.md | Agent SDK |
| GEMINI.md | Google Gemini |
| .github/copilot-instructions.md | GitHub Copilot |



---

## Update Notifier

Knowns CLI automatically checks for updates (1-hour cache):

```
 UPDATE  v1.0.0 available (current v0.8.0) → npm i -g knowns
```

**Disable update check:**
```bash
NO_UPDATE_CHECK=1 knowns task list
```

**Force check:**
```bash
KNOWNS_UPDATE_CHECK=1 knowns task list
```

Update checks are skipped automatically on:
- CI environments
- `--plain` mode
- When `NO_UPDATE_CHECK=1` is set
