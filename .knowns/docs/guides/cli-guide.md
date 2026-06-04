---
title: Knowns CLI Guide
description: Complete guide for using Knowns CLI
createdAt: '2025-12-26T19:43:25.470Z'
updatedAt: '2026-06-04T09:57:29.075Z'
tags:
  - guide
  - cli
  - tutorial
---

# Knowns CLI Guide

Knowns is a CLI tool for managing tasks, documentation, and time tracking for development teams.

## Installation

```bash
# Install via npm (downloads platform-specific Go binary)
npm install -g knowns

# Install via Homebrew (macOS/Linux)
brew install knowns-dev/tap/knowns

# Install via curl (Linux/macOS)
curl -fsSL https://get.knowns.dev/install.sh | sh
```

## Initialize Project

```bash
knowns init [project-name]
```

### Interactive Wizard

When running without a name, the wizard prompts for project basics and project instruction files:

```text
Knowns Project Setup
   Quick configuration

? Project name > my-project
? Git tracking mode > Git Tracked  · tasks, docs, templates
? Project instruction files > CLAUDE.md, AGENTS.md
```

`KNOWNS.md` is always created as the canonical project guidance file when instruction shims are created. Compatibility shims such as `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `OPENCODE.md`, and `.github/copilot-instructions.md` defer behavior rules back to `KNOWNS.md`.

**Example session:**
```text
$ knowns init

Knowns Project Setup
   Quick configuration

? Project name > my-app
? Git tracking mode > Git Tracked  · tasks, docs, templates
? Project instruction files > CLAUDE.md, AGENTS.md

Project initialized: my-app
Created: KNOWNS.md
Created: CLAUDE.md
Created: AGENTS.md

Get started:
  knowns task create "My first task"
  knowns setup all
```

### Wizard Options

| Option | Description |
|--------|-------------|
| **Project name** | Name of your project |
| **Git tracking mode** | `git-tracked`, `git-ignored`, or `none` |
| **Project instruction files** | Compatibility shims to create; defaults to `CLAUDE.md` and `AGENTS.md` |

### Quick Init (Non-Interactive)

```bash
knowns init my-project --no-wizard
```

Non-interactive init uses global project defaults when configured, otherwise it creates the default project guidance set: `KNOWNS.md`, `CLAUDE.md`, and `AGENTS.md`.

### AI Integration Setup

`knowns init` does not create project-level AI integration config such as `.mcp.json`, `.codex/config.toml`, or runtime hooks. Use `knowns setup` for those artifacts:

```bash
knowns setup all            # configure all selected project integrations
knowns setup agents         # create/sync KNOWNS.md + AGENTS.md only
knowns setup codex --global # install Codex integration at user scope
```

This keeps global runtime setup separate from repo-specific project guidance.

---
## MCP Setup

### Quick Setup

```bash
# Setup both project (.mcp.json) and Claude Code globally
knowns mcp setup

# Only create .mcp.json in project
knowns mcp setup --project

# Only add to Claude Code globally
knowns mcp setup --global
```

### Manual MCP Server Start

```bash
knowns mcp           # Start MCP server
knowns mcp --verbose # With debug logging
knowns mcp --info    # Show config instructions
```

---

## Task Management

### Create Task

```bash
knowns task create "Title" -d "Description" --ac "Criterion 1" --ac "Criterion 2"
```

**Options:**
- `-d, --description` - Task description
- `--ac` - Acceptance criteria (repeatable)
- `-l, --labels` - Labels (comma-separated)
- `--priority` - low | medium | high
- `-p, --parent` - Parent task ID

### View Task

```bash
knowns task <id> --plain       # Shorthand
knowns task view <id> --plain  # Full command
```

### List Tasks

```bash
knowns task list --plain
knowns task list --status in-progress --plain
knowns task list --tree --plain
```

### Edit Task

```bash
# Metadata
knowns task edit <id> -t "New title"
knowns task edit <id> -s in-progress

# Acceptance Criteria
knowns task edit <id> --ac "New criterion"
knowns task edit <id> --check-ac 1
knowns task edit <id> --uncheck-ac 1

# Plan & Notes
knowns task edit <id> --plan "1. Step 1
2. Step 2"
knowns task edit <id> --notes "Summary"
knowns task edit <id> --append-notes "Progress"
```

---

## Documentation

### Create Doc

```bash
knowns doc create "Title" -d "Description" -t "tags" -f "folder/path"
```

### View Doc

```bash
knowns doc <path> --plain           # Shorthand
knowns doc view "folder/doc" --plain
```

### Edit Doc

```bash
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
knowns time add <task-id> 2h -n "Note"
```

### Reports

```bash
knowns time report --from "2025-12-01" --to "2025-12-31"
```

---

## Search

```bash
knowns search "query" --plain
knowns search "auth" --type task --plain
knowns search "patterns" --type doc --plain
```

---

## Reference System

| Type | Format | Example |
|------|--------|---------|
| Task | `@task-<id>` | `@task-42` |
| Doc | `@doc/<path>` | `@doc/patterns/module` |

---

## Status & Priority

| Status | Description |
|--------|-------------|
| `todo` | Not started |
| `in-progress` | Currently working |
| `in-review` | In code review |
| `blocked` | Waiting on dependency |
| `done` | Completed |

| Priority | Description |
|----------|-------------|
| `low` | Nice-to-have |
| `medium` | Normal (default) |
| `high` | Urgent |

---

## AI Agent Instructions

### View Guidelines

```bash
knowns agents guideline           # Default guidelines
knowns agents guideline --full    # All sections
knowns agents guideline --compact # Core rules only
```

### Sync to Files

```bash
knowns agents sync                # CLAUDE.md, AGENTS.md
knowns agents sync --all          # All supported files
knowns agents sync --type mcp     # MCP guidelines
```

### Large Documents

For large documents, use the 3-step workflow:

```bash
# Step 1: Check size
knowns doc <path> --info --plain

# Step 2: Get TOC (if >2000 tokens)
knowns doc <path> --toc --plain

# Step 3: Read section
knowns doc <path> --section "2" --plain
```
