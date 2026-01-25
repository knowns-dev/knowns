---
name: knowns.init
description: Use at the start of a new session to read project docs, understand context, and see current state
---

# Session Initialization

Initialize a session by reading project documentation and understanding current state.

**Announce at start:** "I'm using the knowns.init skill to initialize this session."

**Core principle:** READ DOCS BEFORE DOING ANYTHING ELSE.

## The Process

### Step 1: List Available Documentation

{{#if mcp}}
```json
mcp__knowns__list_docs({})
```
{{else}}
```bash
knowns doc list --plain
```
{{/if}}

### Step 2: Read Core Documents

**Priority order:**

{{#if mcp}}
```json
// 1. Project overview (always read)
mcp__knowns__get_doc({ "path": "README", "smart": true })

// 2. Architecture (if exists)
mcp__knowns__get_doc({ "path": "ARCHITECTURE", "smart": true })

// 3. Conventions (if exists)
mcp__knowns__get_doc({ "path": "CONVENTIONS", "smart": true })
```
{{else}}
```bash
# 1. Project overview (always read)
knowns doc "README" --plain

# 2. Architecture (if exists)
knowns doc "ARCHITECTURE" --plain

# 3. Conventions (if exists)
knowns doc "CONVENTIONS" --plain
```
{{/if}}

### Step 3: Check Current State

{{#if mcp}}
```json
// Active timer?
mcp__knowns__get_time_report({})

// Tasks in progress
mcp__knowns__list_tasks({ "status": "in-progress" })

// Board overview
mcp__knowns__get_board({})
```
{{else}}
```bash
# Active timer?
knowns time status

# Tasks in progress
knowns task list --status in-progress --plain

# High priority todos
knowns task list --status todo --plain | head -20
```
{{/if}}

### Step 4: Summarize Context

Provide a brief summary:

```markdown
## Session Context

### Project
- **Name**: [from config]
- **Purpose**: [from README]

### Key Docs Available
- README: [brief note]
- ARCHITECTURE: [if exists]
- CONVENTIONS: [if exists]

### Current State
- Tasks in progress: [count]
- Active timer: [yes/no]

### Ready for
- Working on tasks
- Creating documentation
- Answering questions about codebase
```

## Quick Commands After Init

```
# Work on a task
/knowns.task <id>

# Search for something
{{#if mcp}}
mcp__knowns__search_docs({ "query": "<query>" })
{{else}}
knowns search "<query>" --plain
{{/if}}
```

## When to Re-Initialize

**Run init again when:**
- Starting a new session
- Major project changes occurred
- Switching to different area of project
- Context feels stale

## What to Learn from Docs

From **README**:
- Project purpose and scope
- Key features
- Getting started info

From **ARCHITECTURE**:
- System design
- Component structure
- Key decisions

From **CONVENTIONS**:
- Coding standards
- Naming conventions
- File organization

## Remember

- Always read docs first
- Check for active work (in-progress tasks)
- Summarize context for reference
- Re-init when switching areas
