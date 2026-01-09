---
title: AI Agent Tips
createdAt: '2025-12-31T11:25:59.296Z'
updatedAt: '2026-01-09T08:13:08.078Z'
description: Tips and workarounds for AI agents using Knowns CLI
tags:
  - ai
  - guidelines
  - tips
---
# AI Agent Tips

Tips and workarounds for AI agents using Knowns CLI across different platforms and models.

## Getting Started

Before working on any task, get the guidelines:

```bash
# Output full guidelines to stdout
knowns agents guideline

# CLI-specific guidelines
knowns agents guideline --cli

# MCP-specific guidelines
knowns agents guideline --mcp
```

## Windows Command Line Limit

### Problem

Windows has ~8191 character limit for command line. Long content with `knowns doc edit -c "..."` will fail.

### Workaround: Append in chunks

Instead of one long command, split content and append:

```bash
# 1. Create or reset with short content
knowns doc edit "doc-name" -c "## Overview

Short intro here."

# 2. Append each section separately
knowns doc edit "doc-name" -a "## Section 1

Content for section 1..."
knowns doc edit "doc-name" -a "## Section 2

Content for section 2..."
```

Each append adds `

` (blank line) before new content.

### File-Based Content Options

For very long content, use file-based options:

```bash
# Replace content from file
knowns doc edit "doc-name" --content-file ./my-content.md

# Append content from file
knowns doc edit "doc-name" --append-file ./additional-section.md
```

## Multi-line Content by Platform

### Bash/Zsh (macOS, Linux)

```bash
knowns task edit <id> --plan $'1. Step one
2. Step two
3. Step three'
```

### PowerShell (Windows)

```powershell
knowns task edit <id> --plan "1. Step one`n2. Step two`n3. Step three"
```

### Cross-platform (heredoc)

```bash
knowns task edit <id> --plan "$(cat <<EOF
1. Step one
2. Step two
3. Step three
EOF
)"
```

## Best Practices for AI Agents

1. **Get guidelines first** - `knowns agents guideline`
2. **Always use `--plain` flag** - Machine-readable output for view/list/search
3. **Follow refs recursively** - `@.knowns/docs/...` and `@.knowns/tasks/...`
4. **Read docs before coding** - Understand patterns first
5. **Start timer when taking task** - `knowns time start <id>`
6. **Check AC after completing work** - Not before
7. **Append notes progressively** - `--append-notes` for each milestone
8. **Stop timer when done** - `knowns time stop`

## Agent Instruction Files

### Sync Command

Update AI instruction files (CLAUDE.md, AGENTS.md, etc.):

```bash
# Sync default files (CLAUDE.md, AGENTS.md) with minimal instruction
knowns agents sync

# Sync all files
knowns agents sync --all

# Sync with full embedded guidelines
knowns agents sync --full

# Sync with MCP guidelines
knowns agents sync --type mcp
```

### Template Variants

| Variant | Size | Use Case |
|---------|------|----------|
| **instruction** (default) | ~600 bytes | Minimal - just tells AI to call `knowns agents guideline` |
| **general** | ~4KB | Full guidelines embedded in file |

### Interactive Mode

```bash
# Interactive wizard to select type, variant, and files
knowns agents
```

## Task ID Handling

### ID Formats

Tasks have three ID formats (all work with CLI commands):

| Format | Example | Notes |
|--------|---------|-------|
| Sequential | `48`, `49` | Legacy numeric IDs |
| Hierarchical | `48.1`, `48.2` | Legacy subtask IDs |
| Random | `qkh5ne`, `a7f3k9` | Current CLI generates these |

### Common Mistakes with `--parent`

```bash
# ❌ WRONG: Do NOT prefix with "task-"
knowns task create "Title" --parent task-48        # ERROR!

# ✅ CORRECT: Use raw ID only
knowns task create "Title" --parent 48
knowns task create "Title" --parent qkh5ne
```

### New Subtasks Get Random IDs

When you create a subtask, it gets a random 6-char ID (NOT hierarchical):

```bash
$ knowns task create "API Docs" --parent 48
✓ Created task-qkh5ne: API Docs     # <-- Random ID, not 48.7
  Subtask of: 48
```

## Doc List with Path Filter

Filter docs by folder for focused context:

```bash
# List only guides
knowns doc list "guides/" --plain

# List patterns
knowns doc list "patterns/" --plain
```

## The --plain Flag

**CRITICAL**: The `--plain` flag is ONLY for view/list/search commands:

```bash
# ✅ Correct - view/list/search
knowns task <id> --plain
knowns task list --plain
knowns doc "path" --plain
knowns doc list --plain
knowns search "query" --plain

# ❌ Wrong - create/edit do NOT support --plain
knowns task create "Title" --plain       # ERROR!
knowns task edit <id> -s done --plain    # ERROR!
knowns doc create "Title" --plain        # ERROR!
```
