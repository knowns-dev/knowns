# Guidelines System

Knowns provides a guidelines system for AI agents, optimized for efficient context usage.

---

## Overview

Guidelines are split into 2 parts:

| Type | Location | Size | Content |
|------|----------|------|---------|
| **Core Rules** | `CLAUDE.md`, `GEMINI.md` | ~2KB | Only the most important rules |
| **Full Reference** | `knowns guidelines` | ~15KB | Complete documentation |

**Why split like this?**

- AI agents have limited context windows
- Core rules (~80 lines) contain what MUST be known before working
- Full reference is consulted when details are needed

---

## Core Rules (CLAUDE.md)

The `CLAUDE.md` file contains **only the most critical rules**:

### 1. Session Init
```json
mcp__knowns__detect_projects({})
mcp__knowns__set_project({ "projectRoot": "/path/to/project" })
```

### 2. Critical Rules Table
| Rule | Description |
|------|-------------|
| MCP Tools | Use MCP tools, NEVER edit .md files |
| Docs First | Read docs BEFORE planning |
| Time Tracking | Start timer when taking task |
| Plan Approval | Wait for user approval |
| Check AC After | Only mark done AFTER completing |
| Validate | Run validate before completing |

### 3. CLI Pitfalls
- `-a` flag confusion (assignee vs append)
- `--plain` flag (only for view/list)
- `--parent` (raw ID only)

### 4. Reference to Full Documentation
```
> **Full reference:** Run `knowns guidelines --plain` for complete documentation
```

---

## Full Reference (knowns guidelines)

The `knowns guidelines` command displays complete documentation:

```bash
# View full guidelines
knowns guidelines --plain

# View specific section
knowns guidelines core --plain
knowns guidelines workflow --plain
knowns guidelines mcp --plain
knowns guidelines cli --plain
knowns guidelines mistakes --plain
knowns guidelines context --plain

# Search within guidelines
knowns guidelines --search "acceptance criteria" --plain

# Core rules only (compact)
knowns guidelines --compact --plain
```

### Sections

| Section | Content |
|---------|---------|
| `core` | Core rules and critical mistakes |
| `workflow` | Task creation, execution, completion |
| `mcp` | MCP tools reference |
| `cli` | CLI commands reference |
| `mistakes` | Common mistakes and recovery |
| `context` | Context optimization tips |

---

## Guidelines Types

Knowns supports 3 types of guidelines:

| Type | Flag | Use Case |
|------|------|----------|
| `unified` | `--mode unified` | Both CLI + MCP (default) |
| `mcp` | `--mode mcp` | MCP tools only |
| `cli` | `--mode cli` | CLI commands only |

```bash
# Default: unified
knowns guidelines --plain

# MCP only
knowns guidelines --mode mcp --plain

# CLI only
knowns guidelines --mode cli --plain
```

---

## Sync Guidelines

To update guidelines in instruction files:

```bash
# Sync all instruction files
knowns sync agent

# Sync with force overwrite
knowns sync agent --force

# Sync all files (including non-default)
knowns sync agent --all
```

**Files synced:**
- `CLAUDE.md`
- `GEMINI.md`
- `AGENTS.md`
- `.github/copilot-instructions.md`

---

## Markers

Guidelines in instruction files are wrapped in markers:

```markdown
<!-- KNOWNS GUIDELINES START -->
# Knowns Guidelines
...
<!-- KNOWNS GUIDELINES END -->
```

**Behavior:**
- If markers exist → Replace content between markers
- If no markers → Append to end of file
- Content outside markers is preserved

---

## Structure

### Core Rules (CLAUDE.md)

```
# Knowns Guidelines
> Critical rules reminder

## Session Init (Required)
## Critical Rules
## CLI Pitfalls
## Reference System
## Subtasks
---
> Full reference: Run `knowns guidelines --plain`
```

### Full Reference (knowns guidelines)

```
# Core Rules
## Session Init
## Critical Rules
## The --plain Flag
## Reference System

# Context Optimization
## Output Format
## Search Before Read
## Reading Documents

# MCP Tools Reference
## Task Tools
## Doc Tools
## Time Tools
## Template Tools

# CLI Commands Reference
## task create/edit/view/list
## doc create/edit/view/list
## time start/stop/add
## search

# Task Workflow
## Creation
## Execution
## Completion

# Common Mistakes
## Critical Mistakes
## Recovery
```

---

## Context Optimization

Guidelines include tips to optimize context usage:

### 1. Always use `--plain`
```bash
knowns task 42 --plain        # ✓
knowns task 42 --json         # ✗ (wastes tokens)
```

### 2. Always use `smart: true` for docs
```json
mcp__knowns__get_doc({ "path": "readme", "smart": true })
```

### 3. Search before read
```bash
# ✓ Search first
knowns search "auth" --type doc --plain

# ✗ Don't read all docs hoping to find
knowns doc "doc1" --plain
knowns doc "doc2" --plain
```

### 4. Compact notes
```bash
# ✓ Concise
knowns task edit 42 --append-notes "Done: Auth middleware"

# ✗ Verbose
knowns task edit 42 --append-notes "I have successfully completed..."
```

---

## Related

- [Multi-Platform Support](./multi-platform.md) - Supported platforms
- [MCP Integration](./mcp-integration.md) - MCP tools details
- [Workflow](./workflow.md) - Task workflow
