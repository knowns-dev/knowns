---
title: AI Agent Tips
createdAt: '2025-12-31T11:25:59.296Z'
updatedAt: '2026-01-02T18:46:05.907Z'
description: Tips and workarounds for AI agents using Knowns CLI
tags:
  - ai
  - guidelines
  - tips
---
# AI Agent Tips

Tips and workarounds for AI agents using Knowns CLI across different platforms and models.

## Windows Command Line Limit

### Problem

Windows has ~8191 character limit for command line. Long content with `knowns doc edit -c "..."` will fail.

### Workaround: Append in chunks

Instead of one long command, split content and append:

```bash
# 1. Create or reset with short content
knowns doc edit "doc-name" -c "## Overview\n\nShort intro here."

# 2. Append each section separately
knowns doc edit "doc-name" -a "## Section 1\n\nContent for section 1..."
knowns doc edit "doc-name" -a "## Section 2\n\nContent for section 2..."
knowns doc edit "doc-name" -a "## Section 3\n\nContent for section 3..."
```

Each append adds `\n\n` (blank line) before new content.

## Gemini 2.5 Flash Compatibility

### Problem

Gemini 2.5 Flash may not understand full CLAUDE.md guidelines due to:

* Smaller context window

* Different instruction parsing

* Complex nested structures

### Solution

Use condensed guidelines (see gemini-guidelines when available):

* Shorter, simpler format

* Bullet points over tables

* Essential commands only

* Clear, direct instructions

## Multi-line Content by Platform

### Bash/Zsh (macOS, Linux)

````bash
knowns task edit <id> --plan $'1. Step one\\n2. Step two\\n3. Step three'\n```\n\n### PowerShell (Windows)\n```powershell\nknowns task edit <id> --plan \"1. Step one`n2. Step two`n3. Step three\"\n```\n\n### Cross-platform (heredoc)\n```bash\nknowns task edit <id> --plan \"$(cat <<EOF\n1. Step one\n2. Step two\n3. Step three\nEOF\n)\"\n```

## Best Practices for AI Agents

1. **Always use `--plain` flag** - Machine-readable output
2. **Follow refs recursively** - `@.knowns/docs/...` and `@.knowns/tasks/...`
3. **Read docs before coding** - Understand patterns first
4. **Start timer when taking task** - `knowns time start <id>`
5. **Check AC after completing work** - Not before
6. **Append notes progressively** - `--append-notes` for each milestone
7. **Stop timer when done** - `knowns time stop`

## Test Section From File

## New: File-Based Content Options

For very long content, use file-based options instead of inline content:

```bash
# Replace content from file
knowns doc edit "doc-name" --content-file ./my-content.md

# Append content from file
knowns doc edit "doc-name" --append-file ./additional-section.md
````

This bypasses Windows command line limits entirely.

## Doc List with Path Filter

Filter docs by folder for focused context:

```bash
# List only guides
knowns doc list "guides/" --plain

# List patterns
knowns doc list "patterns/" --plain
```

## Agents Sync

Quickly update AI instruction files:

```bash
# Sync CLAUDE.md and AGENTS.md with CLI guidelines
knowns agents sync

# Sync all files including GEMINI.md
knowns agents sync --all
```

## Template System (v0.3+)

Knowns has a 2x2 template matrix:

| Type | Variant | Description               |
| ---- | ------- | ------------------------- |
| CLI  | General | Full guidelines (~15KB)   |
| CLI  | Gemini  | Compact guidelines (~3KB) |
| MCP  | General | Full MCP tools reference  |
| MCP  | Gemini  | Compact MCP reference     |

### Commands

```bash
# Interactive - prompts for type, variant, files
knowns agents

# CLI with Gemini compact variant
knowns agents sync --gemini

# MCP with Gemini variant
knowns agents sync --type mcp --gemini

# All files with full guidelines
knowns agents sync --all
```

### When to Use Gemini Variant

* Models with smaller context windows (Gemini 2.5 Flash)

* When token efficiency is critical

* Quick reference without full examples

### Template Locations

```text
src/templates/
├── cli/
│   ├── general.md   # Full CLI guidelines
│   └── gemini.md    # Compact CLI (~3KB)
└── mcp/
    ├── general.md   # Full MCP guidelines
    └── gemini.md    # Compact MCP (~2.5KB)
```

#41
