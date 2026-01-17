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

```bash
knowns doc list --plain
```

### Step 2: Read Core Documents

**Priority order:**

```bash
# 1. Project overview (always read)
knowns doc "README" --plain --smart

# 2. Architecture (if exists)
knowns doc "ARCHITECTURE" --plain --smart

# 3. Conventions (if exists)
knowns doc "CONVENTIONS" --plain --smart
```

### Step 3: Check Current State

```bash
# Active timer?
knowns time status

# Tasks in progress
knowns task list --status in-progress --plain

# High priority todos
knowns task list --status todo --plain | head -20
```

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

```bash
# Work on a task
/knowns.task <id>

# Search for something
knowns search "<query>" --plain

# View a doc
knowns doc "<path>" --plain --smart
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
