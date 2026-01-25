<!-- KNOWNS GUIDELINES START -->
<<<<<<< Updated upstream

# Core Rules

=======
# Core Rules

>>>>>>> Stashed changes
> These rules are NON-NEGOTIABLE. Violating them leads to data corruption and lost work.

---

## The Golden Rule

**If you want to change ANYTHING in a task or doc, use MCP tools. NEVER edit .md files directly.**

<<<<<<< Updated upstream
=======

>>>>>>> Stashed changes
---

## Quick Reference

| Rule               | Description                                                     |
| ------------------ | --------------------------------------------------------------- |
| **MCP Tools Only** | Use MCP tools for ALL operations. NEVER edit .md files directly |
<<<<<<< Updated upstream
| **Docs First**     | Read project docs BEFORE planning or coding                     |
| **Time Tracking**  | Start timer when taking task, stop when done                    |
| **Plan Approval**  | Share plan with user, WAIT for approval before coding           |
| **Check AC After** | Only mark criteria done AFTER completing work                   |
=======
| **Docs First** | Read project docs BEFORE planning or coding |
| **Time Tracking** | Start timer when taking task, stop when done |
| **Plan Approval** | Share plan with user, WAIT for approval before coding |
| **Check AC After** | Only mark criteria done AFTER completing work |

>>>>>>> Stashed changes

---

## Reference System

Tasks, docs, and templates can reference each other:

<<<<<<< Updated upstream
| Type     | Writing (Input)    | Reading (Output)            |
| -------- | ------------------ | --------------------------- |
| Task     | `@task-<id>`       | `@.knowns/tasks/task-<id>`  |
| Doc      | `@doc/<path>`      | `@.knowns/docs/<path>.md`   |
=======
| Type | Writing (Input) | Reading (Output) |
|------|-----------------|------------------|
| Task | `@task-<id>` | `@.knowns/tasks/task-<id>` |
| Doc | `@doc/<path>` | `@.knowns/docs/<path>.md` |
>>>>>>> Stashed changes
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
<<<<<<< Updated upstream

=======
>>>>>>> Stashed changes
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

<<<<<<< Updated upstream
| Don't                            | Do Instead                  |
| -------------------------------- | --------------------------- |
| Re-read files already in context | Reference from memory       |
| List tasks/docs multiple times   | List once, remember results |
| Quote entire file contents       | Summarize key points        |
=======
| Don't | Do Instead |
|-------|------------|
| Re-read files already in context | Reference from memory |
| List tasks/docs multiple times | List once, remember results |
| Quote entire file contents | Summarize key points |
>>>>>>> Stashed changes

---

## Efficient Workflow

<<<<<<< Updated upstream
| Phase          | Context-Efficient Approach     |
| -------------- | ------------------------------ |
| **Research**   | Search → Read only matches     |
| **Planning**   | Brief plan, not detailed prose |
| **Coding**     | Read only files being modified |
| **Notes**      | Bullet points, not paragraphs  |
| **Completion** | Summary, not full log          |
=======
| Phase | Context-Efficient Approach |
|-------|---------------------------|
| **Research** | Search → Read only matches |
| **Planning** | Brief plan, not detailed prose |
| **Coding** | Read only files being modified |
| **Notes** | Bullet points, not paragraphs |
| **Completion** | Summary, not full log |
>>>>>>> Stashed changes

---

## Quick Rules

1. **Always `smart: true`** - Auto-handles doc size
<<<<<<< Updated upstream
2. **Search first** - Don't read all docs hoping to find info
3. **Read selectively** - Only fetch what you need
4. **Write concise** - Compact notes, not essays
5. **Don't repeat** - Reference context already loaded
=======
3. **Search first** - Don't read all docs hoping to find info
4. **Read selectively** - Only fetch what you need
5. **Write concise** - Compact notes, not essays
6. **Don't repeat** - Reference context already loaded
>>>>>>> Stashed changes

---

# MCP Tools Reference

## Task Tools

<<<<<<< Updated upstream
### mcp**knowns**create_task
=======
### mcp__knowns__create_task
>>>>>>> Stashed changes

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

<<<<<<< Updated upstream
### mcp**knowns**update_task
=======
### mcp__knowns__update_task
>>>>>>> Stashed changes

```json
{
  "taskId": "<id>",
  "status": "in-progress",
<<<<<<< Updated upstream
  "assignee": "@me"
}
```

### mcp**knowns**get_task

```json
{ "taskId": "<id>" }
```

### mcp**knowns**list_tasks

```json
{ "status": "in-progress", "assignee": "@me" }
```

### mcp**knowns**search_tasks

```json
{ "query": "keyword" }
```

---

## Doc Tools

### mcp**knowns**get_doc

**ALWAYS use `smart: true`** - auto-handles small/large docs:

```json
{ "path": "readme", "smart": true }
```

If large, returns TOC. Then read section:

```json
{ "path": "readme", "section": "3" }
```

### mcp**knowns**list_docs

```json
{ "tag": "api" }
```

### mcp**knowns**create_doc
=======
  "assignee": "@me",
  "addAc": ["Criterion 1", "Criterion 2"],
  "checkAc": [1, 2],
  "uncheckAc": [3],
  "removeAc": [4],
  "plan": "1. Step one\n2. Step two",
  "notes": "Implementation notes",
  "appendNotes": "Additional notes"
}
```

| Field | Purpose |
|-------|---------|
| `addAc` | Add new acceptance criteria |
| `checkAc` | Mark AC done (1-based index) |
| `uncheckAc` | Unmark AC (1-based index) |
| `removeAc` | Remove AC (1-based index) |
| `plan` | Set implementation plan |
| `notes` | Replace implementation notes |
| `appendNotes` | Append to notes |

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
>>>>>>> Stashed changes

```json
{
  "title": "Doc Title",
  "description": "Description",
  "tags": ["tag1"],
  "folder": "guides",
  "content": "Initial content"
}
```

<<<<<<< Updated upstream
### mcp**knowns**update_doc
=======
### mcp__knowns__update_doc
>>>>>>> Stashed changes

```json
{
  "path": "readme",
  "content": "Replace content",
  "section": "2"
}
```

<<<<<<< Updated upstream
### mcp**knowns**search_docs

```json
{ "query": "keyword", "tag": "api" }
=======
### mcp__knowns__search_docs

```json
{ "query": "keyword", "tag": "api" }
```

### mcp__knowns__search (Unified)

```json
{
  "query": "keyword",
  "type": "all",
  "status": "in-progress",
  "priority": "high",
  "assignee": "@me",
  "label": "feature",
  "tag": "api",
  "limit": 20
}
>>>>>>> Stashed changes
```

| Field | Purpose |
|-------|---------|
| `type` | "all", "task", or "doc" |
| `status/priority/assignee/label` | Task filters |
| `tag` | Doc filter |
| `limit` | Max results (default: 20) |

---

## Time Tools

<<<<<<< Updated upstream
### mcp**knowns**start_time
=======
### mcp__knowns__start_time
>>>>>>> Stashed changes

```json
{ "taskId": "<id>" }
```

<<<<<<< Updated upstream
### mcp**knowns**stop_time
=======
### mcp__knowns__stop_time
>>>>>>> Stashed changes

```json
{ "taskId": "<id>" }
```

<<<<<<< Updated upstream
### mcp**knowns**add_time
=======
### mcp__knowns__add_time
>>>>>>> Stashed changes

```json
{
  "taskId": "<id>",
  "duration": "2h30m",
  "note": "Note",
  "date": "2025-01-15"
}
```

<<<<<<< Updated upstream
### mcp**knowns**get_time_report
=======
### mcp__knowns__get_time_report
>>>>>>> Stashed changes

```json
{ "from": "2025-01-01", "to": "2025-01-31", "groupBy": "task" }
```

---

## Template Tools

<<<<<<< Updated upstream
### mcp**knowns**list_templates
=======
### mcp__knowns__list_templates
>>>>>>> Stashed changes

```json
{}
```

<<<<<<< Updated upstream
### mcp**knowns**get_template
=======
### mcp__knowns__get_template
>>>>>>> Stashed changes

```json
{ "name": "template-name" }
```

<<<<<<< Updated upstream
### mcp**knowns**run_template
=======
### mcp__knowns__run_template
>>>>>>> Stashed changes

```json
{
  "name": "template-name",
  "variables": { "name": "MyComponent" },
  "dryRun": true
}
```

<<<<<<< Updated upstream
### mcp**knowns**create_template
=======
### mcp__knowns__create_template
>>>>>>> Stashed changes

```json
{
  "name": "my-template",
  "description": "Description",
  "doc": "patterns/my-pattern"
}
```

---

## Other

<<<<<<< Updated upstream
### mcp**knowns**get_board
=======
### mcp__knowns__get_board
>>>>>>> Stashed changes

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
<<<<<<< Updated upstream

=======
>>>>>>> Stashed changes
```bash
knowns task edit <id> --ac "Outcome 1" --ac "Outcome 2"
```

---

## Quality Guidelines

### Title

| Bad           | Good                   |
| ------------- | ---------------------- |
| Do auth stuff | Add JWT authentication |
| Fix bug       | Fix login timeout      |

### Description

Explain WHY. Include doc refs: `@doc/security-patterns`

### Acceptance Criteria

**Outcome-focused, NOT implementation steps:**

| Bad                        | Good                            |
| -------------------------- | ------------------------------- |
| Add handleLogin() function | User can login                  |
| Use bcrypt                 | Passwords are hashed            |
| Add try-catch              | Errors return proper HTTP codes |

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

<<<<<<< Updated upstream
```bash
knowns task edit <id> --plan $'1. Research (see @doc/xxx)
2. Implement
3. Test
4. Document'
=======
```json
mcp__knowns__update_task({
  "taskId": "<id>",
  "plan": "1. Research (see @doc/xxx)\n2. Implement\n3. Test\n4. Document"
})
>>>>>>> Stashed changes
```

**Share plan with user. WAIT for approval before coding.**

---

## Step 4: Implement

<<<<<<< Updated upstream
```bash
# Check AC only AFTER work is done
knowns task edit <id> --check-ac 1
knowns task edit <id> --append-notes "Done: feature X"
=======
```json
// Check AC only AFTER work is done
mcp__knowns__update_task({
  "taskId": "<id>",
  "checkAc": [1],
  "appendNotes": "Done: feature X"
})
>>>>>>> Stashed changes
```

---

## Scope Changes

If new requirements emerge during work:

<<<<<<< Updated upstream
```bash
# Small: Add to current task
knowns task edit <id> --ac "New requirement"
knowns task edit <id> --append-notes "Scope updated: reason"
```

```json
=======
```json
// Small: Add to current task
mcp__knowns__update_task({
  "taskId": "<id>",
  "addAc": ["New requirement"],
  "appendNotes": "Scope updated: reason"
})

>>>>>>> Stashed changes
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

<<<<<<< Updated upstream
| Requirement    | How                                       |
| -------------- | ----------------------------------------- |
| All AC checked | `knowns task edit <id> --check-ac N`      |
| Notes added    | `knowns task edit <id> --notes "Summary"` |
| Timer stopped  | `mcp__knowns__stop_time`                  |
| Status = done  | `mcp__knowns__update_task`                |
| Tests pass     | Run test suite                            |
=======
| Requirement | How |
|-------------|-----|
| All AC checked | `mcp__knowns__update_task` with `checkAc` |
| Notes added | `mcp__knowns__update_task` with `notes` |
| Timer stopped | `mcp__knowns__stop_time` |
| Status = done | `mcp__knowns__update_task` with `status: "done"` |
| Tests pass | Run test suite |
>>>>>>> Stashed changes

---

## Completion Steps

```json
// 1. Verify all AC are checked
mcp__knowns__get_task({ "taskId": "<id>" })
<<<<<<< Updated upstream
```

```bash
# 2. Add implementation notes
knowns task edit <id> --notes $'## Summary
What was done and key decisions.'
```
=======

// 2. Add implementation notes
mcp__knowns__update_task({
  "taskId": "<id>",
  "notes": "## Summary\nWhat was done and key decisions."
})
>>>>>>> Stashed changes

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
<<<<<<< Updated upstream
```

```bash
# 3. Add AC for the fix
knowns task edit <id> --ac "Fix: description"
knowns task edit <id> --append-notes "Reopened: reason"
=======

// 3. Add AC for the fix
mcp__knowns__update_task({
  "taskId": "<id>",
  "addAc": ["Fix: description"],
  "appendNotes": "Reopened: reason"
})
>>>>>>> Stashed changes
```

Then follow completion steps again.

---

## Checklist

<<<<<<< Updated upstream
- [ ] All AC checked (`--check-ac`)
- [ ] Notes added (`--notes`)
=======
- [ ] All AC checked (`checkAc`)
- [ ] Notes added (`notes`)
>>>>>>> Stashed changes
- [ ] Timer stopped (`mcp__knowns__stop_time`)
- [ ] Tests pass
- [ ] Status = done (`mcp__knowns__update_task`)

---

# Common Mistakes
<<<<<<< Updated upstream

## Quick Reference

| DON'T                     | DO                                                       |
| ------------------------- | -------------------------------------------------------- |
| Edit .md files directly   | Use MCP tools                                            |
| Check AC before work done | Check AC AFTER work done                                 |
| Code before plan approval | Wait for user approval                                   |
| Code before reading docs  | Read docs FIRST                                          |
| Skip time tracking        | Always start/stop timer                                  |
| Ignore refs               | Follow ALL `@task-xxx`, `@doc/xxx`, `@template/xxx` refs |
=======


## Quick Reference

| DON'T | DO |
|-------|-----|
| Edit .md files directly | Use MCP tools |
| Check AC before work done | Check AC AFTER work done |
| Code before plan approval | Wait for user approval |
| Code before reading docs | Read docs FIRST |
| Skip time tracking | Always start/stop timer |
| Ignore refs | Follow ALL `@task-xxx`, `@doc/xxx`, `@template/xxx` refs |
>>>>>>> Stashed changes

---

## MCP Task Operations

<<<<<<< Updated upstream
Some operations require CLI:

| Operation               | Tool                             |
| ----------------------- | -------------------------------- |
| Add acceptance criteria | CLI: `--ac`                      |
| Check/uncheck AC        | CLI: `--check-ac`                |
| Set implementation plan | CLI: `--plan`                    |
| Add/append notes        | CLI: `--notes`, `--append-notes` |
| Basic task fields       | MCP tools                        |
| Time tracking           | MCP tools                        |
| Read tasks/docs         | MCP tools                        |
=======
All task operations are available via MCP:

| Operation | MCP Field |
|-----------|-----------|
| Add acceptance criteria | `addAc: ["criterion"]` |
| Check AC | `checkAc: [1, 2]` (1-based) |
| Uncheck AC | `uncheckAc: [1]` (1-based) |
| Remove AC | `removeAc: [1]` (1-based) |
| Set plan | `plan: "..."` |
| Set notes | `notes: "..."` |
| Append notes | `appendNotes: "..."` |
| Change status | `status: "in-progress"` |
| Assign | `assignee: "@me"` |
>>>>>>> Stashed changes

---

## Error Recovery

<<<<<<< Updated upstream
| Problem              | Solution                                    |
| -------------------- | ------------------------------------------- |
| Forgot to stop timer | `mcp__knowns__add_time` with duration       |
| Wrong status         | `mcp__knowns__update_task` to fix           |
| Task not found       | `mcp__knowns__list_tasks` to find ID        |
| Need to uncheck AC   | CLI: `knowns task edit <id> --uncheck-ac N` |

=======
| Problem | Solution |
|---------|----------|
| Forgot to stop timer | `mcp__knowns__add_time` with duration |
| Wrong status | `mcp__knowns__update_task` to fix |
| Task not found | `mcp__knowns__list_tasks` to find ID |
| Need to uncheck AC | `mcp__knowns__update_task` with `uncheckAc: [N]` |
| Checked AC too early | `mcp__knowns__update_task` with `uncheckAc: [N]` |
>>>>>>> Stashed changes
<!-- KNOWNS GUIDELINES END -->
