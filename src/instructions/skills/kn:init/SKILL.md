---
name: kn:init
description: Use at the start of a new session to read project docs, understand context, and see current state
---

# Session Initialization

**Announce:** "Using kn:init to initialize session."

**Core principle:** READ DOCS BEFORE DOING ANYTHING ELSE.

## Step 1: List Docs

```json
mcp__knowns__list_docs({})
```

## Step 2: Read Core Docs

```json
mcp__knowns__get_doc({ "path": "README", "smart": true })
mcp__knowns__get_doc({ "path": "ARCHITECTURE", "smart": true })
mcp__knowns__get_doc({ "path": "CONVENTIONS", "smart": true })
```

## Step 3: Check Current State

```json
mcp__knowns__list_tasks({ "status": "in-progress" })
mcp__knowns__get_board({})
```

## Step 4: Summarize

```markdown
## Session Context
- **Project**: [name]
- **Key Docs**: README, ARCHITECTURE, CONVENTIONS
- **In-progress tasks**: [count]
- **Ready for**: tasks, docs, questions
```

## Next Steps

```
/kn:plan <task-id>     # Plan a task
/kn:research <query>   # Research codebase
```
