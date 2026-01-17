<!-- KNOWNS GUIDELINES START -->
# Core Rules (MCP)

You MUST follow these rules. If you cannot follow any rule, stop and ask for guidance before proceeding.

---

## The Golden Rule

**If you want to change ANYTHING in a task or doc, use MCP tools. NEVER edit .md files directly.**

Why? Direct file editing breaks metadata synchronization, Git tracking, and relationships.

---

## Core Principles

| Rule | Description |
|------|-------------|
| **MCP Tools Only** | Use MCP tools for ALL operations. NEVER edit .md files directly |
| **Docs First** | Read project docs BEFORE planning or coding |
| **Time Tracking** | Always start timer when taking task, stop when done |
| **Plan Approval** | Share plan with user, WAIT for approval before coding |
| **Check AC After Work** | Only mark acceptance criteria done AFTER completing the work |

---

## Reference System

| Context | Task Format | Doc Format |
|---------|-------------|------------|
| **Writing** (input) | `@task-<id>` | `@doc/<path>` |
| **Reading** (output) | `@.knowns/tasks/task-<id>` | `@.knowns/docs/<path>.md` |

Follow refs recursively until complete context gathered.

---

## Task IDs

| Format | Example | Notes |
|--------|---------|-------|
| Sequential | `48`, `49` | Legacy numeric |
| Hierarchical | `48.1`, `48.2` | Legacy subtasks |
| Random | `qkh5ne` | Current (6-char) |

**CRITICAL:** Use raw ID (string) for all MCP tool calls.

---

## Status & Priority

| Status | When |
|--------|------|
| `todo` | Not started (default) |
| `in-progress` | Currently working |
| `in-review` | PR submitted |
| `blocked` | Waiting on dependency |
| `done` | All criteria met |

| Priority | Level |
|----------|-------|
| `low` | Nice-to-have |
| `medium` | Normal (default) |
| `high` | Urgent |

---

# Context Optimization (MCP)

Optimize your context usage to work more efficiently within token limits.

---

## Search Before Read

```json
// DON'T: Read all docs hoping to find info
mcp__knowns__get_doc({ "path": "doc1" })
mcp__knowns__get_doc({ "path": "doc2" })
mcp__knowns__get_doc({ "path": "doc3" })

// DO: Search first, then read only relevant docs
mcp__knowns__search_docs({ "query": "authentication" })
mcp__knowns__get_doc({ "path": "security-patterns" })  // Only the relevant one
```

---

## Use Filters

```json
// DON'T: List all tasks then filter manually
mcp__knowns__list_tasks({})

// DO: Use filters in the query
mcp__knowns__list_tasks({
  "status": "in-progress",
  "assignee": "@me"
})
```

---

## Reading Documents (smart)

**ALWAYS use `smart: true` when reading documents.** It automatically handles both small and large docs:

```json
// DON'T: Read without smart (may get truncated large doc)
mcp__knowns__get_doc({ "path": "readme" })

// DO: Always use smart
mcp__knowns__get_doc({ "path": "readme", "smart": true })
// Small doc → returns full content
// Large doc → returns stats + TOC

// DO: If doc is large, read specific section
mcp__knowns__get_doc({ "path": "readme", "section": "3" })
```

**`smart: true` behavior:**

- **≤2000 tokens**: Returns full content automatically
- **>2000 tokens**: Returns stats + TOC, then use `section` parameter

---

## Compact Notes

```bash
# DON'T: Verbose notes
knowns task edit 42 --append-notes "I have successfully completed the implementation..."

# DO: Compact notes
knowns task edit 42 --append-notes "Done: Auth middleware + JWT validation"
```

---

## Avoid Redundant Operations

| Don't                                 | Do Instead                  |
| ------------------------------------- | --------------------------- |
| Re-read tasks/docs already in context | Reference from memory       |
| List tasks/docs multiple times        | List once, remember results |
| Fetch same task repeatedly            | Cache the result            |

---

## Efficient Workflow

| Phase          | Context-Efficient Approach     |
| -------------- | ------------------------------ |
| **Research**   | Search -> Read only matches    |
| **Planning**   | Brief plan, not detailed prose |
| **Coding**     | Read only files being modified |
| **Notes**      | Bullet points, not paragraphs  |
| **Completion** | Summary, not full log          |

---

## Quick Rules

1. **Always `smart: true`** - Use smart when reading docs (auto-handles size)
2. **Search first** - Don't read all docs hoping to find info
3. **Use filters** - Don't list everything then filter manually
4. **Read selectively** - Only fetch what you need
5. **Write concise** - Compact notes, not essays
6. **Don't repeat** - Reference context already loaded
7. **Summarize** - Key points, not full quotes

---

# MCP Tools Reference

## mcp**knowns**create_task

Create a new task.

```json
{
  "title": "Task title",
  "description": "Task description",
  "status": "todo",
  "priority": "medium",
  "labels": ["label1", "label2"],
  "assignee": "@me",
  "parent": "parent-task-id"
}
```

| Parameter     | Required | Description                             |
| ------------- | -------- | --------------------------------------- |
| `title`       | Yes      | Task title                              |
| `description` | No       | Task description                        |
| `status`      | No       | todo/in-progress/in-review/blocked/done |
| `priority`    | No       | low/medium/high                         |
| `labels`      | No       | Array of labels                         |
| `assignee`    | No       | Assignee (use @me for self)             |
| `parent`      | No       | Parent task ID for subtasks             |

**Note:** Acceptance criteria must be added via `mcp__knowns__update_task` after creation.

---

## mcp**knowns**update_task

Update task fields.

```json
{
  "taskId": "abc123",
  "title": "New title",
  "description": "New description",
  "status": "in-progress",
  "priority": "high",
  "labels": ["updated"],
  "assignee": "@me"
}
```

| Parameter     | Required | Description       |
| ------------- | -------- | ----------------- |
| `taskId`      | Yes      | Task ID to update |
| `title`       | No       | New title         |
| `description` | No       | New description   |
| `status`      | No       | New status        |
| `priority`    | No       | New priority      |
| `labels`      | No       | New labels array  |
| `assignee`    | No       | New assignee      |

**Note:** For acceptance criteria, implementation plan, and notes - use CLI commands or edit task file directly through knowns CLI.

---

## mcp**knowns**get_task

Get a task by ID.

```json
{
  "taskId": "abc123"
}
```

---

## mcp**knowns**list_tasks

List tasks with optional filters.

```json
{
  "status": "in-progress",
  "priority": "high",
  "assignee": "@me",
  "label": "bug"
}
```

All parameters are optional filters.

---

## mcp**knowns**search_tasks

Search tasks by query string.

```json
{
  "query": "authentication"
}
```

---

## mcp**knowns**get_doc

Get a documentation file by path.

```json
{
  "path": "README"
}
```

Path can be filename or folder/filename (without .md extension).

### Reading Documents (smart)

**ALWAYS use `smart: true` when reading documents.** It automatically handles both small and large docs:

```json
// Always use smart (recommended)
{
  "path": "readme",
  "smart": true
}
```

**Behavior:**

- **Small doc (≤2000 tokens)**: Returns full content automatically
- **Large doc (>2000 tokens)**: Returns stats + TOC with numbered sections

```json
// If doc is large, smart returns TOC, then read specific section:
{
  "path": "readme",
  "section": "3"
}
```

| Parameter | Description                                                    |
| --------- | -------------------------------------------------------------- |
| `smart`   | **Recommended.** Auto-return full content or TOC based on size |
| `section` | Read specific section by number (e.g., "3") or title           |

### Manual Control (info, toc, section)

If you need manual control instead of `smart`:

```json
{ "path": "readme", "info": true }     // Check size/tokens
{ "path": "readme", "toc": true }      // View table of contents
{ "path": "readme", "section": "3" }   // Read specific section
```

---

## mcp**knowns**list_docs

List all documentation files.

```json
{
  "tag": "api"
}
```

Optional `tag` parameter to filter by tag.

---

## mcp**knowns**create_doc

Create a new documentation file.

```json
{
  "title": "Doc Title",
  "description": "Doc description",
  "tags": ["tag1", "tag2"],
  "folder": "guides",
  "content": "Initial content"
}
```

### Document Structure Best Practice

When creating/updating docs, use clear heading structure for `toc` and `section` to work properly:

```markdown
# Main Title (H1 - only one)

## 1. Overview

Brief introduction...

## 2. Installation

Step-by-step guide...

## 3. Configuration

### 3.1 Basic Config

...

### 3.2 Advanced Config

...

## 4. API Reference

...
```

**Writing rules:**

- Use numbered headings (`## 1. Overview`) for easy `section: "1"` access
- Keep H1 for title only, use H2 for main sections
- Use H3 for subsections within H2
- Each section should be self-contained (readable without context)

**Reading workflow:**

```json
// Always use smart (handles both small and large docs automatically)
{ "path": "<path>", "smart": true }

// If doc is large, smart returns TOC, then read specific section:
{ "path": "<path>", "section": "2" }
```

---

## mcp**knowns**update_doc

Update an existing documentation file.

```json
{
  "path": "README",
  "title": "New Title",
  "description": "New description",
  "tags": ["new", "tags"],
  "content": "Replace content",
  "appendContent": "Append to existing"
}
```

Use either `content` (replace) or `appendContent` (append), not both.

### Section Edit (Context-Efficient)

Replace only a specific section instead of entire document:

```json
// Step 1: View TOC to find section
{ "path": "readme", "toc": true }

// Step 2: Edit only that section
{
  "path": "readme",
  "section": "2. Installation",
  "content": "New content here..."
}
```

This reduces context usage significantly - no need to read/write entire document.

---

## mcp**knowns**search_docs

Search documentation by query.

```json
{
  "query": "authentication",
  "tag": "api"
}
```

---

## mcp**knowns**start_time

Start time tracking for a task.

```json
{
  "taskId": "abc123"
}
```

---

## mcp**knowns**stop_time

Stop time tracking.

```json
{
  "taskId": "abc123"
}
```

---

## mcp**knowns**add_time

Manually add a time entry.

```json
{
  "taskId": "abc123",
  "duration": "2h30m",
  "note": "Optional note",
  "date": "2025-01-15"
}
```

---

## mcp**knowns**get_time_report

Get time tracking report.

```json
{
  "from": "2025-01-01",
  "to": "2025-01-31",
  "groupBy": "task"
}
```

`groupBy` can be: task, label, or status.

---

## mcp**knowns**get_board

Get current board state with tasks grouped by status.

```json
{}
```

No parameters required.

---

# Task Creation (MCP)

## Before Creating

```json
// Search for existing tasks first
mcp__knowns__search_tasks({ "query": "keyword" })
```

---

## Create Task

```json
mcp__knowns__create_task({
  "title": "Clear title (WHAT)",
  "description": "Description (WHY). Related: @doc/security-patterns",
  "priority": "medium",
  "labels": ["feature", "auth"]
})
```

**Note:** Add acceptance criteria after creation using CLI:
```bash
knowns task edit <id> --ac "Outcome 1" --ac "Outcome 2"
```

---

## Quality Guidelines

### Title
| Bad | Good |
|-----|------|
| Do auth stuff | Add JWT authentication |
| Fix bug | Fix login timeout |

### Description
Explain WHY. Include doc refs: `@doc/security-patterns`

### Acceptance Criteria
**Outcome-focused, NOT implementation steps:**

| Bad | Good |
|-----|------|
| Add handleLogin() function | User can login |
| Use bcrypt | Passwords are hashed |
| Add try-catch | Errors return proper HTTP codes |

---

## Subtasks

```json
// Create parent first
mcp__knowns__create_task({ "title": "Parent task" })

// Then create subtask with parent ID
mcp__knowns__create_task({
  "title": "Subtask",
  "parent": "parent-task-id"
})
```

---

## Anti-Patterns

- Too many AC in one task -> Split into multiple tasks
- Implementation steps as AC -> Write outcomes instead
- Skip search -> Always check existing tasks first

---

# Task Execution (MCP)

## Step 1: Take Task

```json
// Update status and assignee
mcp__knowns__update_task({
  "taskId": "abc123",
  "status": "in-progress",
  "assignee": "@me"
})

// Start timer (REQUIRED!)
mcp__knowns__start_time({ "taskId": "abc123" })
```

---

## Step 2: Research

```json
// Read task and follow ALL refs
mcp__knowns__get_task({ "taskId": "abc123" })

// @.knowns/docs/xxx.md -> read the doc
mcp__knowns__get_doc({ "path": "xxx" })

// @.knowns/tasks/task-YY -> read the task
mcp__knowns__get_task({ "taskId": "YY" })

// Search related docs
mcp__knowns__search_docs({ "query": "keyword" })

// Check similar done tasks
mcp__knowns__list_tasks({ "status": "done" })
```

---

## Step 3: Plan (BEFORE coding!)

Use CLI for implementation plan:
```bash
knowns task edit <id> --plan $'1. Research (see @doc/xxx)
2. Implement
3. Test
4. Document'
```

**Share plan with user. WAIT for approval before coding.**

---

## Step 4: Implement

Use CLI for checking acceptance criteria:
```bash
# Check AC only AFTER work is done
knowns task edit <id> --check-ac 1
knowns task edit <id> --append-notes "Done: feature X"
```

---

## Scope Changes

If new requirements emerge during work:

```bash
# Small: Add to current task
knowns task edit <id> --ac "New requirement"
knowns task edit <id> --append-notes "Scope updated: reason"

# Large: Ask user first, then create follow-up
```

```json
mcp__knowns__create_task({
  "title": "Follow-up: feature",
  "description": "From task <id>"
})
```

**Don't silently expand scope. Ask user first.**

---

## Key Rules

1. **Plan before code** - Capture approach first
2. **Wait for approval** - Don't start without OK
3. **Check AC after work** - Not before
4. **Ask on scope changes** - Don't expand silently

---

# Task Completion (MCP)

## Definition of Done

A task is **Done** when ALL of these are complete:

| Requirement | How |
|-------------|-----|
| All AC checked | CLI: `knowns task edit <id> --check-ac N` |
| Notes added | CLI: `knowns task edit <id> --notes "Summary"` |
| Timer stopped | MCP: `mcp__knowns__stop_time` |
| Status = done | MCP: `mcp__knowns__update_task` |
| Tests pass | Run test suite |

---

## Completion Steps

```json
// 1. Verify all AC are checked
mcp__knowns__get_task({ "taskId": "abc123" })
```

```bash
# 2. Add implementation notes (use CLI)
knowns task edit abc123 --notes $'## Summary
What was done and key decisions.'
```

```json
// 3. Stop timer (REQUIRED!)
mcp__knowns__stop_time({ "taskId": "abc123" })

// 4. Mark done
mcp__knowns__update_task({
  "taskId": "abc123",
  "status": "done"
})
```

---

## Post-Completion Changes

If user requests changes after task is done:

```json
// 1. Reopen task
mcp__knowns__update_task({
  "taskId": "abc123",
  "status": "in-progress"
})

// 2. Restart timer
mcp__knowns__start_time({ "taskId": "abc123" })
```

```bash
# 3. Add AC for the fix
knowns task edit abc123 --ac "Fix: description"
knowns task edit abc123 --append-notes "Reopened: reason"
```

Then follow completion steps again.

---

## Checklist

- [ ] All AC checked (CLI `--check-ac`)
- [ ] Notes added (CLI `--notes`)
- [ ] Timer stopped (`mcp__knowns__stop_time`)
- [ ] Tests pass
- [ ] Status = done (`mcp__knowns__update_task`)

---

# Common Mistakes (MCP)

## Quick Reference

| DON'T | DO |
|-------|-----|
| Edit .md files directly | Use MCP tools |
| Skip time tracking | Always `start_time`/`stop_time` |
| Check AC before work done | Check AC AFTER work done |
| Code before plan approval | Wait for user approval |
| Code before reading docs | Read docs FIRST |
| Ignore task refs | Follow ALL `@.knowns/...` refs |
| Use wrong task ID format | Use raw ID string |

---

## MCP vs CLI Usage

Some operations require CLI (not available in MCP):

| Operation | Tool |
|-----------|------|
| Add acceptance criteria | CLI: `--ac` |
| Check/uncheck AC | CLI: `--check-ac`, `--uncheck-ac` |
| Set implementation plan | CLI: `--plan` |
| Add/append notes | CLI: `--notes`, `--append-notes` |
| Create/update task basic fields | MCP tools |
| Time tracking | MCP tools |
| Read tasks/docs | MCP tools |
| Search | MCP tools |

---

## Error Recovery

| Problem | Solution |
|---------|----------|
| Forgot to stop timer | `mcp__knowns__add_time` with duration |
| Wrong status | `mcp__knowns__update_task` to fix |
| Task not found | `mcp__knowns__list_tasks` to find ID |
| Need to uncheck AC | CLI: `knowns task edit <id> --uncheck-ac N` |
<!-- KNOWNS GUIDELINES END -->
