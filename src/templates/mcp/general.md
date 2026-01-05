<!-- KNOWNS GUIDELINES START -->
# Knowns MCP Guidelines

## Core Principles

### 1. MCP Tool Operations
**Use MCP tools for ALL Knowns operations. NEVER edit .md files directly.**

This ensures data integrity, maintains proper change history, and prevents file corruption.

### 2. Documentation-First (For AI Agents)
**ALWAYS read project documentation BEFORE planning or coding.**

AI agents must understand project context, conventions, and existing patterns before making any changes. This prevents rework and ensures consistency.

---

## AI Agent Guidelines

> **CRITICAL**: Before performing ANY task, AI agents MUST read documentation to understand project context.

### First-Time Initialization

When starting a new session or working on an unfamiliar project:

```
# 1. List all available documentation
mcp__knowns__list_docs({})

# 2. Read essential project docs (prioritize these)
mcp__knowns__get_doc({ path: "README" })
mcp__knowns__get_doc({ path: "ARCHITECTURE" })
mcp__knowns__get_doc({ path: "CONVENTIONS" })
mcp__knowns__get_doc({ path: "API" })

# 3. Review current task backlog
mcp__knowns__list_tasks({})
mcp__knowns__list_tasks({ status: "in-progress" })
```

### Before Taking Any Task

```
# 1. View the task details
mcp__knowns__get_task({ taskId: "<id>" })

# 2. Follow ALL refs in the task (see Reference System section)
# @.knowns/tasks/task-44 - ... → mcp__knowns__get_task({ taskId: "44" })
# @.knowns/docs/patterns/module.md → mcp__knowns__get_doc({ path: "patterns/module" })

# 3. Search for additional related documentation
mcp__knowns__search_docs({ query: "<keywords from task>" })

# 4. Read ALL related docs before planning
mcp__knowns__get_doc({ path: "<related-doc>" })

# 5. Check for similar completed tasks (learn from history)
mcp__knowns__search_tasks({ query: "<keywords>", status: "done" })
```

### Why Documentation First?

| Without Reading Docs | With Reading Docs |
|---------------------|-------------------|
| Reinvent existing patterns | Reuse established patterns |
| Break conventions | Follow project standards |
| Duplicate code | Use existing utilities |
| Wrong architecture decisions | Align with system design |
| Inconsistent naming | Match naming conventions |

### Context Checklist for Agents

Before writing ANY code, ensure you can answer:

- [ ] Have I followed ALL refs (`@.knowns/...`) in the task?
- [ ] Have I followed nested refs recursively?
- [ ] What is the project's overall architecture?
- [ ] What coding conventions does this project follow?
- [ ] Are there existing patterns/utilities I should reuse?
- [ ] What are the testing requirements?
- [ ] How should I structure my implementation?

> **Remember**: A few minutes reading docs saves hours of rework. NEVER skip this step.

---

## Reference System (Refs)

Tasks and docs can contain **references** to other tasks/docs. AI agents MUST understand and follow these refs to gather complete context.

### Reference Formats

| Type | When Writing (Input) | When Reading (Output) | MCP Tool |
|------|---------------------|----------------------|----------|
| **Task ref** | `@task-<id>` | `@.knowns/tasks/task-<id> - <title>.md` | `mcp__knowns__get_task({ taskId: "<id>" })` |
| **Doc ref** | `@doc/<path>` | `@.knowns/docs/<path>.md` | `mcp__knowns__get_doc({ path: "<path>" })` |

> **CRITICAL for AI Agents**:
> - When **WRITING** refs (in descriptions, plans, notes): Use `@task-<id>` and `@doc/<path>`
> - When **READING** output: You'll see `@.knowns/tasks/...` and `@.knowns/docs/...`
> - **NEVER write** the output format (`@.knowns/...`) - always use input format

### How to Follow Refs

When you read a task and see refs in system output format, follow them:

```
# Example: Task 42 output contains:
# @.knowns/tasks/task-44 - CLI Task Create Command.md
# @.knowns/docs/patterns/module.md

# Follow task ref (extract ID from task-<id>)
mcp__knowns__get_task({ taskId: "44" })

# Follow doc ref (extract path, remove .md)
mcp__knowns__get_doc({ path: "patterns/module" })
```

### Recursive Following

Refs can be nested. Follow until complete context is gathered:

```
Task 42
  → @.knowns/docs/README.md
    → @.knowns/docs/patterns/module.md (found in README)
      → (read for full pattern details)
```

> **CRITICAL**: Never assume you understand a task fully without following its refs. Refs contain essential context that may change your implementation approach.

---

## Quick Start

```
# Initialize project (use CLI for this)
knowns init [name]

# Create task with acceptance criteria
mcp__knowns__create_task({
  title: "Title",
  description: "Description",
  priority: "high",
  labels: ["label1", "label2"]
})

# View task
mcp__knowns__get_task({ taskId: "<id>" })

# List tasks
mcp__knowns__list_tasks({})

# Search (tasks + docs)
mcp__knowns__search_tasks({ query: "query" })
mcp__knowns__search_docs({ query: "query" })
```

---

## End-to-End Example

Here's a complete workflow for an AI agent implementing a feature:

```
# === AGENT SESSION START (Do this once per session) ===

# 0a. List all available documentation
mcp__knowns__list_docs({})

# 0b. Read essential project docs
mcp__knowns__get_doc({ path: "README" })
mcp__knowns__get_doc({ path: "ARCHITECTURE" })
mcp__knowns__get_doc({ path: "CONVENTIONS" })

# Now the agent understands project context and conventions

# === TASK WORKFLOW ===

# 1. Create the task
mcp__knowns__create_task({
  title: "Add password reset flow",
  description: "Users need ability to reset forgotten passwords via email",
  priority: "high",
  labels: ["auth", "feature"]
})

# Output: Created task 42

# 2. Take the task and start timer
mcp__knowns__update_task({
  taskId: "42",
  status: "in-progress",
  assignee: "@howznguyen"
})
mcp__knowns__start_time({ taskId: "42" })

# 3. Search for related documentation
mcp__knowns__search_docs({ query: "password security" })

# 4. Read the documentation
mcp__knowns__get_doc({ path: "security-patterns" })

# 5. Create implementation plan (SHARE WITH USER, WAIT FOR APPROVAL)
mcp__knowns__update_task({
  taskId: "42",
  plan: "1. Review security patterns (see @doc/security-patterns)\n2. Design token generation with 1-hour expiry\n3. Implement /forgot-password endpoint\n4. Add unit tests"
})

# 6. After approval, implement and update task progressively
mcp__knowns__update_task({
  taskId: "42",
  appendNotes: "✓ Implemented /forgot-password endpoint"
})

# 7. Add final implementation notes
mcp__knowns__update_task({
  taskId: "42",
  notes: "## Summary\nImplemented complete password reset flow.\n\n## Changes\n- Added POST /forgot-password endpoint\n- Added POST /reset-password endpoint"
})

# 8. Stop timer and complete
mcp__knowns__stop_time({ taskId: "42" })
mcp__knowns__update_task({
  taskId: "42",
  status: "done"
})
```

---

## Task Workflow

### Step 1: Take Task

```
# Update task status and assign to self
mcp__knowns__update_task({
  taskId: "<id>",
  status: "in-progress",
  assignee: "@<your-username>"
})
```

> **Note**: Use your username as configured in the project. Check project config for `defaultAssignee`.

### Step 2: Start Time Tracking (REQUIRED)

```
mcp__knowns__start_time({ taskId: "<id>" })
```

> **CRITICAL**: Time tracking is MANDATORY. Always start timer when taking a task and stop when done. This data is essential for:
> - Accurate project estimation
> - Identifying bottlenecks
> - Resource planning
> - Sprint retrospectives

### Step 3: Read Related Documentation

> **FOR AI AGENTS**: This step is MANDATORY, not optional. You must understand the codebase before planning.

```
# Search for related docs
mcp__knowns__search_docs({ query: "authentication" })

# View relevant documents
mcp__knowns__get_doc({ path: "API Guidelines" })
mcp__knowns__get_doc({ path: "Security Patterns" })

# Also check for similar completed tasks
mcp__knowns__search_tasks({ query: "auth", status: "done" })
```

> **CRITICAL**: ALWAYS read related documentation BEFORE planning!

### Step 4: Create Implementation Plan

```
mcp__knowns__update_task({
  taskId: "<id>",
  plan: "1. Research patterns (see @doc/security-patterns)\n2. Design middleware\n3. Implement\n4. Add tests\n5. Update docs"
})
```

> **CRITICAL**:
> - Share plan with user and **WAIT for approval** before coding
> - Include doc references using `@doc/<path>` format

### Step 5: Implement

```
# Work through implementation plan step by step
# IMPORTANT: Only update task AFTER completing the work, not before

# After completing work, append notes:
mcp__knowns__update_task({
  taskId: "<id>",
  appendNotes: "✓ Completed: <brief description>"
})
```

> **CRITICAL**: Never claim work is done before it's actually completed.

### Step 6: Handle Dynamic Requests (During Implementation)

If the user adds new requirements during implementation:

```
# Append note about scope change
mcp__knowns__update_task({
  taskId: "<id>",
  appendNotes: "⚠️ Scope updated: Added requirement for X per user request"
})

# Continue with Step 5 (Implement) for new requirements
```

> **Note**: Always document scope changes. This helps track why a task took longer than expected.

### Step 7: Add Implementation Notes

```
# Add comprehensive notes (suitable for PR description)
mcp__knowns__update_task({
  taskId: "<id>",
  notes: "## Summary\n\nImplemented JWT auth.\n\n## Changes\n- Added middleware\n- Added tests"
})

# OR append progressively (recommended)
mcp__knowns__update_task({
  taskId: "<id>",
  appendNotes: "✓ Implemented middleware"
})
```

### Step 8: Stop Time Tracking (REQUIRED)

```
mcp__knowns__stop_time({ taskId: "<id>" })
```

> **CRITICAL**: Never forget to stop the timer. If you forget, use manual entry:
> `mcp__knowns__add_time({ taskId: "<id>", duration: "2h", note: "Forgot to stop timer" })`

### Step 9: Complete Task

```
mcp__knowns__update_task({
  taskId: "<id>",
  status: "done"
})
```

### Step 10: Handle Post-Completion Changes (If Applicable)

If the user requests changes or updates AFTER task is marked done:

```
# 1. Reopen task - set back to in-progress
mcp__knowns__update_task({
  taskId: "<id>",
  status: "in-progress"
})

# 2. Restart time tracking (REQUIRED)
mcp__knowns__start_time({ taskId: "<id>" })

# 3. Document the reopen reason
mcp__knowns__update_task({
  taskId: "<id>",
  appendNotes: "🔄 Reopened: User requested changes - <reason>"
})

# 4. Follow Step 5-9 again (Implement → Notes → Stop Timer → Done)
```

> **CRITICAL**: Treat post-completion changes as a mini-workflow. Always:
> - Reopen task (in-progress)
> - Start timer again
> - Document why it was reopened
> - Follow the same completion process

### Step 11: Knowledge Extraction (Post-Completion)

After completing a task, extract reusable knowledge to docs:

```
# Search if similar pattern already documented
mcp__knowns__search_docs({ query: "<pattern/concept>" })

# If new knowledge, create a doc for future reference
mcp__knowns__create_doc({
  title: "Pattern: <Name>",
  description: "Reusable pattern discovered during task implementation",
  tags: ["pattern", "<domain>"],
  folder: "patterns"
})

# Or append to existing doc
mcp__knowns__update_doc({
  path: "<existing-doc>",
  appendContent: "## New Section\n\nLearned from task <id>: ..."
})
```

**When to extract knowledge:**
- New patterns/conventions discovered
- Common error solutions
- Reusable code snippets or approaches
- Integration patterns with external services
- Performance optimization techniques

> **CRITICAL**: Only extract **generalizable** knowledge. Task-specific details belong in implementation notes, not docs.

---

## Essential MCP Tools

### Task Management

```
# Create task
mcp__knowns__create_task({
  title: "Title",
  description: "Description",
  priority: "high",        # low, medium, high
  labels: ["label1"],
  status: "todo",          # todo, in-progress, in-review, done, blocked
  assignee: "@username"
})

# Get task
mcp__knowns__get_task({ taskId: "<id>" })

# Update task
mcp__knowns__update_task({
  taskId: "<id>",
  title: "New title",
  description: "New description",
  status: "in-progress",
  priority: "high",
  assignee: "@username",
  labels: ["new", "labels"],
  plan: "Implementation plan...",
  notes: "Implementation notes...",
  appendNotes: "Append to existing notes..."
})

# List tasks
mcp__knowns__list_tasks({})
mcp__knowns__list_tasks({ status: "in-progress" })
mcp__knowns__list_tasks({ assignee: "@username" })
mcp__knowns__list_tasks({ priority: "high" })
mcp__knowns__list_tasks({ label: "feature" })

# Search tasks
mcp__knowns__search_tasks({ query: "auth" })
```

### Time Tracking

```
# Start timer
mcp__knowns__start_time({ taskId: "<id>" })

# Stop timer
mcp__knowns__stop_time({ taskId: "<id>" })

# Manual entry
mcp__knowns__add_time({
  taskId: "<id>",
  duration: "2h",           # e.g., "2h", "30m", "1h30m"
  note: "Optional note",
  date: "2025-12-25"        # Optional, defaults to now
})

# Reports
mcp__knowns__get_time_report({})
mcp__knowns__get_time_report({
  from: "2025-12-01",
  to: "2025-12-31",
  groupBy: "task"           # task, label, status
})
```

### Documentation

```
# List docs
mcp__knowns__list_docs({})
mcp__knowns__list_docs({ tag: "architecture" })

# Get doc
mcp__knowns__get_doc({ path: "README" })
mcp__knowns__get_doc({ path: "patterns/module" })

# Create doc
mcp__knowns__create_doc({
  title: "Title",
  description: "Description",
  tags: ["tag1", "tag2"],
  folder: "folder/path",    # Optional
  content: "Initial content..."
})

# Update doc
mcp__knowns__update_doc({
  path: "doc-name",
  title: "New Title",
  description: "New description",
  tags: ["new", "tags"],
  content: "Replace content...",
  appendContent: "Append to content..."
})

# Search docs
mcp__knowns__search_docs({ query: "patterns" })
mcp__knowns__search_docs({ query: "auth", tag: "security" })
```

#### Doc Organization

| Doc Type | Location | Example |
|----------|----------|---------|
| **Important/Core docs** | Root `.knowns/docs/` | `README.md`, `ARCHITECTURE.md`, `CONVENTIONS.md` |
| **Guides** | `.knowns/docs/guides/` | `guides/getting-started.md` |
| **Patterns** | `.knowns/docs/patterns/` | `patterns/controller.md` |
| **API docs** | `.knowns/docs/api/` | `api/endpoints.md` |
| **Other categorized docs** | `.knowns/docs/<category>/` | `security/auth-patterns.md` |

```
# Important docs - at root (no folder)
mcp__knowns__create_doc({ title: "README", description: "Project overview", tags: ["core"] })
mcp__knowns__create_doc({ title: "ARCHITECTURE", description: "System design", tags: ["core"] })

# Categorized docs - use folder
mcp__knowns__create_doc({ title: "Getting Started", description: "Setup guide", tags: ["guide"], folder: "guides" })
mcp__knowns__create_doc({ title: "Controller Pattern", description: "MVC pattern", tags: ["pattern"], folder: "patterns" })
```

### Board

```
# Get kanban board view
mcp__knowns__get_board({})
```

---

## Task Structure

### Title

Clear summary (WHAT needs to be done).

| Bad | Good |
|-----|------|
| Do auth stuff | Add JWT authentication |
| Fix bug | Fix login timeout on slow networks |
| Update docs | Document rate limiting in API.md |

### Description

Explains WHY and WHAT (not HOW). **Link related docs using `@doc/<path>`**

```
We need JWT authentication because sessions don't scale for our microservices architecture.

Related docs: @doc/security-patterns, @doc/api-guidelines
```

### Acceptance Criteria

**Outcome-oriented**, testable criteria. NOT implementation steps.

| Bad (Implementation details) | Good (Outcomes) |
|------------------------------|-----------------|
| Add function handleLogin() in auth.ts | User can login and receive JWT token |
| Use bcrypt for hashing | Passwords are securely hashed |
| Add try-catch blocks | Errors return appropriate HTTP status codes |

---

## Definition of Done

A task is **Done** ONLY when **ALL** criteria are met:

### Via MCP Tools (Required)

- [ ] All work completed and verified
- [ ] Implementation notes added via `update_task`
- [ ] ⏱️ Timer stopped: `mcp__knowns__stop_time` (MANDATORY - do not skip!)
- [ ] Status set to done via `update_task`
- [ ] Knowledge extracted to docs (if applicable)

### Via Code (Required)

- [ ] All tests pass
- [ ] Documentation updated
- [ ] Code reviewed (linting, formatting)
- [ ] No regressions introduced

---

## Status & Priority Reference

### Status Values

| Status | Description | When to Use |
|--------|-------------|-------------|
| `todo` | Not started | Default for new tasks |
| `in-progress` | Currently working | After taking task |
| `in-review` | In code review | PR submitted |
| `blocked` | Waiting on dependency | External blocker |
| `done` | Completed | All criteria met |

### Priority Values

| Priority | Description |
|----------|-------------|
| `low` | Can wait, nice-to-have |
| `medium` | Normal priority (default) |
| `high` | Urgent, time-sensitive |

---

## Common Mistakes

| Wrong | Right |
|-------|-------|
| Edit .md files directly | Use MCP tools |
| Skip time tracking | ALWAYS use `start_time` and `stop_time` |
| Start coding without reading docs | Read ALL related docs FIRST |
| Plan without checking docs | Read docs before planning |
| Code before plan approval | Share plan, WAIT for approval |
| Mark done without all criteria | Verify ALL criteria first |
| Ignore refs in task description | Follow ALL refs before planning |
| Follow only first-level refs | Recursively follow nested refs |

---

## Long Content Handling

For long documentation content, append in chunks:

```
# 1. Create doc with initial content
mcp__knowns__create_doc({
  title: "Doc Title",
  content: "## Overview\n\nShort intro."
})

# 2. Append each section separately
mcp__knowns__update_doc({
  path: "doc-title",
  appendContent: "## Section 1\n\nContent for section 1..."
})

mcp__knowns__update_doc({
  path: "doc-title",
  appendContent: "## Section 2\n\nContent for section 2..."
})
```

> **Tip**: Each `appendContent` adds content after existing content. Use this for large docs to avoid context limits.

---

## Best Practices Checklist

### For AI Agents: Session Start

- [ ] List all docs: `mcp__knowns__list_docs({})`
- [ ] Read README/ARCHITECTURE docs
- [ ] Understand coding conventions
- [ ] Review current task backlog

### Before Starting Work

- [ ] Task details retrieved: `mcp__knowns__get_task`
- [ ] ALL refs in task followed
- [ ] Nested refs recursively followed
- [ ] Related docs searched and read
- [ ] Similar done tasks reviewed for patterns
- [ ] Task assigned to self via `update_task`
- [ ] Status set to in-progress
- [ ] Timer started: `mcp__knowns__start_time`

### During Work

- [ ] Implementation plan created and approved
- [ ] Doc links included in plan: `@doc/<path>`
- [ ] Progress notes appended: `appendNotes`

### After Work

- [ ] All work verified complete
- [ ] Implementation notes added
- [ ] Timer stopped: `mcp__knowns__stop_time`
- [ ] Tests passing
- [ ] Documentation updated
- [ ] Status set to done
- [ ] Knowledge extracted to docs (if applicable)

---

## Quick Reference

```
# === AGENT INITIALIZATION (Once per session) ===
mcp__knowns__list_docs({})
mcp__knowns__get_doc({ path: "README" })
mcp__knowns__get_doc({ path: "ARCHITECTURE" })
mcp__knowns__get_doc({ path: "CONVENTIONS" })

# === FULL WORKFLOW ===
mcp__knowns__create_task({ title: "Title", description: "Description" })
mcp__knowns__update_task({ taskId: "<id>", status: "in-progress", assignee: "@me" })
mcp__knowns__start_time({ taskId: "<id>" })                    # ⏱️ REQUIRED
mcp__knowns__search_docs({ query: "keyword" })
mcp__knowns__get_doc({ path: "Doc Name" })
mcp__knowns__search_tasks({ query: "keyword", status: "done" }) # Learn from history
mcp__knowns__update_task({ taskId: "<id>", plan: "1. Step\n2. Step" })
# ... wait for approval, then implement ...
mcp__knowns__update_task({ taskId: "<id>", appendNotes: "✓ Completed: feature X" })
mcp__knowns__stop_time({ taskId: "<id>" })                     # ⏱️ REQUIRED
mcp__knowns__update_task({ taskId: "<id>", status: "done" })
# Optional: Extract knowledge to docs if generalizable patterns found

# === VIEW & SEARCH ===
mcp__knowns__get_task({ taskId: "<id>" })
mcp__knowns__list_tasks({})
mcp__knowns__list_tasks({ status: "in-progress", assignee: "@me" })
mcp__knowns__search_tasks({ query: "bug" })
mcp__knowns__search_docs({ query: "pattern" })

# === TIME TRACKING ===
mcp__knowns__start_time({ taskId: "<id>" })
mcp__knowns__stop_time({ taskId: "<id>" })
mcp__knowns__add_time({ taskId: "<id>", duration: "2h" })
mcp__knowns__get_time_report({})

# === DOCUMENTATION ===
mcp__knowns__list_docs({})
mcp__knowns__get_doc({ path: "path/doc-name" })
mcp__knowns__create_doc({ title: "Title", description: "Desc", tags: ["tag"] })
mcp__knowns__update_doc({ path: "doc-name", appendContent: "New content" })
```

---

**Maintained By**: Knowns CLI Team

<!-- KNOWNS GUIDELINES END -->
