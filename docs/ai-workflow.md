# AI Agent Workflow

Guide for AI assistants working with Knowns.

## Core Principles

### 1. CLI-Only Operations

**NEVER edit .md files directly.** Always use CLI commands:

```bash
# Correct
knowns task edit 42 --check-ac 1

# Wrong
# Editing .knowns/tasks/task-42.md directly
```

### 2. Documentation-First

**ALWAYS read documentation BEFORE planning or coding:**

```bash
knowns doc list --plain
knowns doc "patterns/auth" --plain
```

### 3. Always Use --plain

**ALWAYS use `--plain` flag for AI-readable output:**

```bash
knowns task 42 --plain
knowns doc list --plain
knowns search "auth" --plain
```

## Session Initialization

When starting a new session:

```bash
# 1. List all documentation
knowns doc list --plain

# 2. Read essential docs
knowns doc "README" --plain
knowns doc "ARCHITECTURE" --plain

# 3. Review current tasks
knowns task list --plain
knowns task list --status in-progress --plain
```

## Taking a Task

### Step 1: Read the task

```bash
knowns task 42 --plain              # Shorthand
knowns task view 42 --plain         # Full command
```

### Step 2: Follow ALL references

If the task contains `@doc/patterns/auth`:

```bash
knowns doc "patterns/auth" --plain  # Shorthand
```

If it contains `@task-38`:

```bash
knowns task 38 --plain              # Shorthand
```

### Step 3: Search for related docs

```bash
knowns search "authentication" --type doc --plain
```

### Step 4: Check similar completed tasks

```bash
knowns search "auth" --type task --status done --plain
```

### Step 5: Take the task

```bash
knowns task edit 42 -s in-progress -a @me
knowns time start 42
```

## Planning

### Create implementation plan

```bash
knowns task edit 42 --plan $'1. Review @doc/patterns/auth
2. Implement login endpoint
3. Add JWT token generation
4. Write unit tests
5. Update documentation'
```

**Important:** Share plan with user and WAIT for approval before coding.

## Implementing

### Check criteria as you complete them

```bash
knowns task edit 42 --check-ac 1
knowns task edit 42 --append-notes "Implemented login endpoint"

knowns task edit 42 --check-ac 2
knowns task edit 42 --append-notes "JWT generation working"
```

## Completing

### Add implementation notes

```bash
knowns task edit 42 --notes $'## Summary
Implemented JWT authentication.

## Changes
- Added login endpoint
- Added token generation

## Tests
- 10 unit tests added'
```

### Stop timer and complete

```bash
knowns time stop
knowns task edit 42 -s done
```

## Reference Resolution

When you see references in task output:

| You see | Command to run |
|---------|----------------|
| `@.knowns/tasks/task-38 - Title.md` | `knowns task 38 --plain` |
| `@.knowns/docs/patterns/auth.md` | `knowns doc "patterns/auth" --plain` |

## Context Checklist

Before writing ANY code:

- [ ] Have I read all `@doc/...` references in the task?
- [ ] Have I checked all `@task-...` references?
- [ ] Have I searched for related documentation?
- [ ] Have I reviewed similar completed tasks?
- [ ] Do I understand the project's patterns?
- [ ] Have I shared my plan and received approval?

## Common Mistakes

| Wrong | Right |
|-------|-------|
| Edit .md files directly | Use `knowns task edit` |
| Skip reading docs | Read ALL related docs first |
| Forget `--plain` flag | Always use `--plain` |
| Code before plan approval | Wait for approval |
| Mark done without all criteria | Check ALL criteria first |

## Quick Reference

```bash
# Initialize context
knowns doc list --plain
knowns doc "README" --plain

# Take task
knowns task 42 --plain
knowns task edit 42 -s in-progress -a @me
knowns time start 42

# Work
knowns task edit 42 --plan "1. Step\n2. Step"
knowns task edit 42 --check-ac 1
knowns task edit 42 --append-notes "Progress"

# Complete
knowns task edit 42 --notes "Summary"
knowns time stop
knowns task edit 42 -s done
```

## Guidelines System

Knowns provides **modular guidelines** that AI agents can request at session start.

### Modular Structure

Guidelines are organized into focused sections:

| Section | Description |
|---------|-------------|
| **Core Rules** | Golden rules, must-follow principles |
| **Commands Reference** | CLI/MCP commands quick reference |
| **Workflow Creation** | Task creation workflow |
| **Workflow Execution** | Task execution workflow |
| **Workflow Completion** | Task completion workflow |
| **Common Mistakes** | Anti-patterns and DO vs DON'T |

### Getting Guidelines

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

### MCP Tool

```
mcp__knowns__get_guideline({})                    # Full guidelines
mcp__knowns__get_guideline({ type: "unified" })   # Full guidelines
mcp__knowns__get_guideline({ type: "cli" })       # (Legacy) Same as unified
mcp__knowns__get_guideline({ type: "mcp" })       # (Legacy) Same as unified
```

### Syncing Instruction Files

Update AI instruction files (CLAUDE.md, AGENTS.md, etc.):

```bash
# Interactive mode - select type, variant, files
knowns agents

# Quick sync with full embedded guidelines (~26KB)
knowns agents sync

# Sync with minimal instruction only (~1KB)
knowns agents sync --minimal

# Sync all files (CLAUDE.md, AGENTS.md, GEMINI.md, Copilot)
knowns agents sync --all
```

### Template Variants

| Variant | Size | Description |
|---------|------|-------------|
| **general** (default) | ~26KB | Full modular guidelines embedded in file |
| **instruction** (`--minimal`) | ~1KB | Minimal - tells AI to call `knowns agents guideline` |

The **general** (full) variant is recommended because:
- AI has immediate access to all guidelines
- No extra command execution required
- Works reliably across all AI models
- Ensures consistent behavior from the start
