<!-- KNOWNS GUIDELINES START -->
# Core Rules

> These rules are NON-NEGOTIABLE. Violating them leads to data corruption and lost work.

---

## The Golden Rule

**If you want to change ANYTHING in a task or doc, use MCP tools. NEVER edit .md files directly.**


---

## Quick Reference

| Rule | Description |
|------|-------------|
| **MCP Tools Only** | Use MCP tools for ALL operations. NEVER edit .md files directly |
| **Docs First** | Read project docs BEFORE planning or coding |
| **Time Tracking** | Start timer when taking task, stop when done |
| **Plan Approval** | Share plan with user, WAIT for approval before coding |
| **Check AC After** | Only mark criteria done AFTER completing work |


---

## Reference System

Tasks, docs, and templates can reference each other:

| Type | Writing (Input) | Reading (Output) |
|------|-----------------|------------------|
| Task | `@task-<id>` | `@.knowns/tasks/task-<id>` |
| Doc | `@doc/<path>` | `@.knowns/docs/<path>.md` |
| Template | `@template/<name>` | `@.knowns/templates/<name>` |

**Always follow refs recursively** to gather complete context before planning.

---

## Subtasks

```json
mcp__knowns__create_task({
  "title": "Subtask title",
  "parent": "parent-task-id"
})
```

**CRITICAL:** Use raw ID (string) for all MCP tool calls.

---

# Context Optimization

Optimize your context usage to work more efficiently within token limits.

---


## Search Before Read

```json
// DON'T: Read all docs hoping to find info
mcp__knowns__get_doc({ "path": "doc1" })
mcp__knowns__get_doc({ "path": "doc2" })

// DO: Search first, then read only relevant docs
mcp__knowns__search_docs({ "query": "authentication" })
mcp__knowns__get_doc({ "path": "security-patterns" })
```

---

## Use Filters

```json
// DON'T: List all then filter manually
mcp__knowns__list_tasks({})

// DO: Use filters in the query
mcp__knowns__list_tasks({
  "status": "in-progress",
  "assignee": "@me"
})
```

---

## Reading Documents

**ALWAYS use `smart: true`** - auto-handles both small and large docs:

```json
// DON'T: Read without smart
mcp__knowns__get_doc({ "path": "readme" })

// DO: Always use smart
mcp__knowns__get_doc({ "path": "readme", "smart": true })
// Small doc → full content
// Large doc → stats + TOC

// If large, read specific section:
mcp__knowns__get_doc({ "path": "readme", "section": "3" })
```

**Behavior:**
- **≤2000 tokens**: Returns full content automatically
- **>2000 tokens**: Returns stats + TOC, then use section parameter

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

| Don't | Do Instead |
|-------|------------|
| Re-read files already in context | Reference from memory |
| List tasks/docs multiple times | List once, remember results |
| Quote entire file contents | Summarize key points |

---

## Efficient Workflow

| Phase | Context-Efficient Approach |
|-------|---------------------------|
| **Research** | Search → Read only matches |
| **Planning** | Brief plan, not detailed prose |
| **Coding** | Read only files being modified |
| **Notes** | Bullet points, not paragraphs |
| **Completion** | Summary, not full log |

---

## Quick Rules

1. **Always `smart: true`** - Auto-handles doc size
3. **Search first** - Don't read all docs hoping to find info
4. **Read selectively** - Only fetch what you need
5. **Write concise** - Compact notes, not essays
6. **Don't repeat** - Reference context already loaded

---

# MCP Tools Reference

## Task Tools

### mcp__knowns__create_task

```json
{
  "title": "Task title",
  "description": "Task description",
  "status": "todo",
  "priority": "medium",
  "labels": ["label1"],
  "assignee": "@me",
  "parent": "parent-id"
}
```

### mcp__knowns__update_task

```json
{
  "taskId": "<id>",
  "status": "in-progress",
  "assignee": "@me"
}
```

### mcp__knowns__get_task

```json
{ "taskId": "<id>" }
```

### mcp__knowns__list_tasks

```json
{ "status": "in-progress", "assignee": "@me" }
```

### mcp__knowns__search_tasks

```json
{ "query": "keyword" }
```

---

## Doc Tools

### mcp__knowns__get_doc

**ALWAYS use `smart: true`** - auto-handles small/large docs:

```json
{ "path": "readme", "smart": true }
```

If large, returns TOC. Then read section:
```json
{ "path": "readme", "section": "3" }
```

### mcp__knowns__list_docs

```json
{ "tag": "api" }
```

### mcp__knowns__create_doc

```json
{
  "title": "Doc Title",
  "description": "Description",
  "tags": ["tag1"],
  "folder": "guides",
  "content": "Initial content"
}
```

### mcp__knowns__update_doc

```json
{
  "path": "readme",
  "content": "Replace content",
  "section": "2"
}
```

### mcp__knowns__search_docs

```json
{ "query": "keyword", "tag": "api" }
```

---

## Time Tools

### mcp__knowns__start_time

```json
{ "taskId": "<id>" }
```

### mcp__knowns__stop_time

```json
{ "taskId": "<id>" }
```

### mcp__knowns__add_time

```json
{
  "taskId": "<id>",
  "duration": "2h30m",
  "note": "Note",
  "date": "2025-01-15"
}
```

### mcp__knowns__get_time_report

```json
{ "from": "2025-01-01", "to": "2025-01-31", "groupBy": "task" }
```

---

## Template Tools

### mcp__knowns__list_templates

```json
{}
```

### mcp__knowns__get_template

```json
{ "name": "template-name" }
```

### mcp__knowns__run_template

```json
{
  "name": "template-name",
  "variables": { "name": "MyComponent" },
  "dryRun": true
}
```

### mcp__knowns__create_template

```json
{
  "name": "my-template",
  "description": "Description",
  "doc": "patterns/my-pattern"
}
```

---

## Other

### mcp__knowns__get_board

```json
{}
```

---

# Task Creation

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

**Note:** Add acceptance criteria after creation:
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

# Task Execution

## Step 1: Take Task

```json
// Update status and assignee
mcp__knowns__update_task({
  "taskId": "<id>",
  "status": "in-progress",
  "assignee": "@me"
})

// Start timer (REQUIRED!)
mcp__knowns__start_time({ "taskId": "<id>" })
```

---

## Step 2: Research

```json
// Read task and follow ALL refs
mcp__knowns__get_task({ "taskId": "<id>" })

// @doc/xxx -> read the doc
mcp__knowns__get_doc({ "path": "xxx", "smart": true })

// @task-YY -> read the task
mcp__knowns__get_task({ "taskId": "YY" })

// Search related docs
mcp__knowns__search_docs({ "query": "keyword" })
```

---

## Step 3: Plan (BEFORE coding!)

```bash
knowns task edit <id> --plan $'1. Research (see @doc/xxx)
2. Implement
3. Test
4. Document'
```

**Share plan with user. WAIT for approval before coding.**

---

## Step 4: Implement

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
```

```json
// Large: Ask user first, then create follow-up
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

# Task Completion

## Definition of Done

A task is **Done** when ALL of these are complete:

| Requirement | How |
|-------------|-----|
| All AC checked | `knowns task edit <id> --check-ac N` |
| Notes added | `knowns task edit <id> --notes "Summary"` |
| Timer stopped | `mcp__knowns__stop_time` |
| Status = done | `mcp__knowns__update_task` |
| Tests pass | Run test suite |

---

## Completion Steps

```json
// 1. Verify all AC are checked
mcp__knowns__get_task({ "taskId": "<id>" })
```

```bash
# 2. Add implementation notes
knowns task edit <id> --notes $'## Summary
What was done and key decisions.'
```

```json
// 3. Stop timer (REQUIRED!)
mcp__knowns__stop_time({ "taskId": "<id>" })

// 4. Mark done
mcp__knowns__update_task({
  "taskId": "<id>",
  "status": "done"
})
```

---

## Post-Completion Changes

If user requests changes after task is done:

```json
// 1. Reopen task
mcp__knowns__update_task({
  "taskId": "<id>",
  "status": "in-progress"
})

// 2. Restart timer
mcp__knowns__start_time({ "taskId": "<id>" })
```

```bash
# 3. Add AC for the fix
knowns task edit <id> --ac "Fix: description"
knowns task edit <id> --append-notes "Reopened: reason"
```

Then follow completion steps again.

---

## Checklist

- [ ] All AC checked (`--check-ac`)
- [ ] Notes added (`--notes`)
- [ ] Timer stopped (`mcp__knowns__stop_time`)
- [ ] Tests pass
- [ ] Status = done (`mcp__knowns__update_task`)

---

# Common Mistakes


## Quick Reference

| DON'T | DO |
|-------|-----|
| Edit .md files directly | Use MCP tools |
| Check AC before work done | Check AC AFTER work done |
| Code before plan approval | Wait for user approval |
| Code before reading docs | Read docs FIRST |
| Skip time tracking | Always start/stop timer |
| Ignore refs | Follow ALL `@task-xxx`, `@doc/xxx`, `@template/xxx` refs |

---

## MCP vs CLI Usage

Some operations require CLI:

| Operation | Tool |
|-----------|------|
| Add acceptance criteria | CLI: `--ac` |
| Check/uncheck AC | CLI: `--check-ac` |
| Set implementation plan | CLI: `--plan` |
| Add/append notes | CLI: `--notes`, `--append-notes` |
| Basic task fields | MCP tools |
| Time tracking | MCP tools |
| Read tasks/docs | MCP tools |

---

## Error Recovery

| Problem | Solution |
|---------|----------|
| Forgot to stop timer | `mcp__knowns__add_time` with duration |
| Wrong status | `mcp__knowns__update_task` to fix |
| Task not found | `mcp__knowns__list_tasks` to find ID |
| Need to uncheck AC | CLI: `knowns task edit <id> --uncheck-ac N` |
<!-- KNOWNS GUIDELINES END -->