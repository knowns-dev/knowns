---
title: AI Agent Tips
createdAt: '2025-12-31T11:25:59.296Z'
updatedAt: '2026-01-11T08:59:03.616Z'
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
# Full guidelines (all sections) - default
knowns agents guideline

# Compact (core rules + common mistakes only)
knowns agents guideline --compact

# Stage-specific guidelines
knowns agents guideline --stage creation    # When creating tasks
knowns agents guideline --stage execution   # When implementing
knowns agents guideline --stage completion  # When finishing

# Individual sections
knowns agents guideline --core       # Core rules only
knowns agents guideline --commands   # Commands reference
knowns agents guideline --mistakes   # Common mistakes
```

## Modular Guidelines Structure

Guidelines are organized into focused sections:

| Section | Description |
|---------|-------------|
| **Core Rules** | Golden rules, must-follow principles |
| **Commands Reference** | CLI/MCP commands quick reference |
| **Workflow Creation** | Task creation workflow |
| **Workflow Execution** | Task execution workflow |
| **Workflow Completion** | Task completion workflow |
| **Common Mistakes** | Anti-patterns and DO vs DON'T |

## Windows Command Line Limit

### Problem

Windows has ~8191 character limit for command line. Long content with `knowns doc edit -c "..."` will fail.

### Workaround 1: Append in chunks

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

Each append adds a newline automatically.

### Workaround 2: Use file-based options

```bash
# Replace content with file contents
knowns doc edit "doc-name" --content-file ./new-content.md

# Append file contents
knowns doc edit "doc-name" --append-file ./additional-section.md
```

## Common Flag Confusion

### `-a` vs `--ac`

**CRITICAL**: The `-a` flag means different things in different commands!

| Command | `-a` means | To add acceptance criteria |
|---------|------------|---------------------------|
| `task create` | Assignee | Use `--ac` |
| `task edit` | Assignee | Use `--ac` |
| `doc edit` | Append content | N/A |

**Wrong:**
```bash
# This sets ASSIGNEE, not acceptance criteria!
knowns task edit 42 -a "User can login"
```

**Correct:**
```bash
# Use --ac for acceptance criteria
knowns task edit 42 --ac "User can login"

# Use -a for assignee
knowns task edit 42 -a @me
```

## Multi-line Input

### Bash / Zsh

```bash
knowns task edit 42 --plan $'1. Step one
2. Step two
3. Step three'
```

### PowerShell

```powershell
knowns task edit 42 --plan "1. Step one`n2. Step two`n3. Step three"
```

### Using heredoc (for long content)

```bash
knowns task edit 42 --plan "$(cat <<EOF
1. Research existing patterns
2. Design solution
3. Implement
4. Write tests
5. Update documentation
EOF
)"
```

## MCP vs CLI Guidelines

Both CLI and MCP now use the same **unified modular guidelines**. The `--cli` and `--mcp` flags are legacy and return the same content.

For MCP:
```
mcp__knowns__get_guideline({})    # Full guidelines
```
