---
title: Gemini Agent Guidelines
createdAt: '2025-12-31T11:45:09.512Z'
updatedAt: '2025-12-31T12:42:18.003Z'
description: Condensed guidelines for Gemini 2.5 Flash AI agents
tags:
  - ai
  - guidelines
  - gemini
---
# Knowns CLI - Quick Reference for AI Agents

Simplified guidelines for Gemini and other AI models with smaller context windows.

## CRITICAL RULES

- NEVER edit .md files directly
- ALWAYS use CLI commands
- ALWAYS use --plain flag for output
- Read docs BEFORE coding
- Start timer when taking task
- Stop timer when done

## SESSION START

```bash
# List and read docs first
knowns doc list --plain
knowns doc "README" --plain
knowns task list --plain
```

## TASK COMMANDS

```bash
# View task
knowns task <id> --plain

# Take task
knowns task edit <id> -s in-progress -a @me
knowns time start <id>

# Update task
knowns task edit <id> --check-ac 1
knowns task edit <id> --append-notes "Done: feature X"

# Complete task
knowns time stop
knowns task edit <id> -s done
```

## DOC COMMANDS

```bash
# View doc
knowns doc "path/name" --plain

# Create doc
knowns doc create "Title" -d "Description" -t "tags" -f "folder"

# Edit doc (append for long content)
knowns doc edit "name" -c "Short content"
knowns doc edit "name" -a "Append section 1"
knowns doc edit "name" -a "Append section 2"
```

## SEARCH

```bash
knowns search "keyword" --plain
knowns search "keyword" --type doc --plain
knowns search "keyword" --type task --plain
```

## FOLLOWING REFS

When you see refs in output, follow them:
- `@.knowns/tasks/task-X - ...` → `knowns task X --plain`
- `@doc/path` → `knowns doc "path" --plain`

When writing refs:
- Task ref: `@task-X`
- Doc ref: `@doc/path`

## STATUS VALUES

- todo
- in-progress
- in-review
- done
- blocked

## PRIORITY VALUES

- low
- medium
- high

## WINDOWS TIPS

For long content, append in chunks:
```bash
knowns doc edit "name" -a "Section 1..."
knowns doc edit "name" -a "Section 2..."
```

Do NOT try to write everything in one command.

## NEW COMMANDS

### List docs by folder
```bash
knowns doc list "guides/" --plain
knowns doc list "patterns/" --plain
```

### File-based edit (for long content)
```bash
knowns doc edit "name" --content-file ./file.md
knowns doc edit "name" --append-file ./more.md
```

### Validate & Repair
```bash
knowns doc validate "name" --plain
knowns doc repair "name" --plain
knowns task validate <id> --plain
knowns task repair <id> --plain
```

### Search & Replace in doc
```bash
knowns doc search-in "name" "query" --plain
knowns doc replace "name" "old" "new"
knowns doc replace-section "name" "## Header" "new content"
```

### Sync agent guidelines
```bash
knowns agents sync           # Sync CLAUDE.md, AGENTS.md
knowns agents sync --all     # Include GEMINI.md, Copilot
```

## Template Variants (v0.3+)

Knowns now has compact templates specifically for Gemini:

```bash
# Sync with compact Gemini variant (recommended for Gemini 2.5 Flash)
knowns agents sync --gemini

# MCP variant for Gemini
knowns agents sync --type mcp --gemini

# All files with Gemini variant
knowns agents sync --all --gemini
```

The Gemini variant is ~10x smaller than full guidelines, containing:
- Essential rules only
- Command cheatsheet format
- Minimal examples
- Same workflow, less tokens
