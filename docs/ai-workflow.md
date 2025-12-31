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

## Guidelines Templates

Knowns provides different guideline templates optimized for different AI models:

### Template Matrix

| Type | Variant | Size | Best For |
|------|---------|------|----------|
| cli | general | ~15KB | Claude, GPT-4, large context |
| cli | gemini | ~3KB | Gemini 2.5 Flash |
| mcp | general | ~12KB | Claude Desktop MCP |
| mcp | gemini | ~2.5KB | Gemini with MCP |

### Syncing Guidelines

```bash
# Interactive mode - select type, variant, files
knowns agents

# Quick sync with defaults (CLI general)
knowns agents sync

# Sync with compact Gemini variant
knowns agents sync --gemini

# Sync MCP guidelines
knowns agents sync --type mcp

# Sync all files (CLAUDE.md, AGENTS.md, GEMINI.md, Copilot)
knowns agents sync --all

# Combine options
knowns agents sync --type mcp --gemini --all
```

### When to Use Gemini Variant

- Models with smaller context windows
- When token efficiency is critical
- Quick reference without full examples
