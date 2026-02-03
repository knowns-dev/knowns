<!-- KNOWNS GUIDELINES START -->
# Core Rules

> These rules are NON-NEGOTIABLE. Violating them leads to data corruption and lost work.

---

## The Golden Rule

**If you want to change ANYTHING in a task or doc, use MCP tools (preferred) or CLI commands (fallback). NEVER edit .md files directly.**

---

## CRITICAL: The -a Flag Confusion

The `-a` flag means DIFFERENT things in different commands:

| Command | `-a` Means | NOT This! |
|---------|------------|-----------|
| `task create` | `--assignee` (assign user) | ~~acceptance criteria~~ |
| `task edit` | `--assignee` (assign user) | ~~acceptance criteria~~ |
| `doc edit` | `--append` (append content) | ~~assignee~~ |

### Acceptance Criteria: Use --ac

```bash
# WRONG: -a is assignee, NOT acceptance criteria!
knowns task edit 35 -a "- [ ] Criterion"    # Sets assignee to garbage!

# CORRECT: Use --ac for acceptance criteria
knowns task edit 35 --ac "Criterion one"
knowns task create "Title" --ac "Criterion one" --ac "Criterion two"
```

---

## Quick Reference

| Rule | Description |
|------|-------------|
| **MCP Tools (preferred)** | Use MCP tools for ALL operations. Fallback to CLI if needed. NEVER edit .md files directly |
| **Docs First** | Read project docs BEFORE planning or coding |
| **Time Tracking** | Start timer when taking task, stop when done |
| **Plan Approval** | Share plan with user, WAIT for approval before coding |
| **Check AC After** | Only mark criteria done AFTER completing work |

---

## The --plain Flag

**ONLY for view/list/search commands (NOT create/edit):**

```bash
# CORRECT
knowns task <id> --plain
knowns task list --plain
knowns doc "path" --plain
knowns search "query" --plain

# WRONG (create/edit don't support --plain)
knowns task create "Title" --plain       # ERROR!
knowns task edit <id> -s done --plain    # ERROR!
```

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

### CLI
```bash
knowns task create "Subtask title" --parent 48
```

**CRITICAL:** Use raw ID for `--parent`:
```bash
# CORRECT
knowns task create "Title" --parent 48

# WRONG
knowns task create "Title" --parent task-48
```
### MCP
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

## Output Format

```bash
# Verbose output
knowns task 42 --json

# Compact output (always use --plain)
knowns task 42 --plain
```

---

## Search Before Read

### CLI
```bash
# DON'T: Read all docs hoping to find info
knowns doc "doc1" --plain
knowns doc "doc2" --plain

# DO: Search first, then read only relevant docs
knowns search "authentication" --type doc --plain
knowns doc "security-patterns" --plain
```
### MCP
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

### CLI
**ALWAYS use `--smart`** - auto-handles both small and large docs:

```bash
# DON'T: Read without --smart
knowns doc readme --plain

# DO: Always use --smart
knowns doc readme --plain --smart
# Small doc → full content
# Large doc → stats + TOC

# If large, read specific section:
knowns doc readme --plain --section 3
```
### MCP
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

1. **Always `--plain`** - Never use `--json` unless needed
2. **Always `--smart`** - Auto-handles doc size
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
```

| Field | Purpose |
|-------|---------|
| `type` | "all", "task", or "doc" |
| `status/priority/assignee/label` | Task filters |
| `tag` | Doc filter |
| `limit` | Max results (default: 20) |

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

# CLI Commands Reference

## task create

```bash
knowns task create <title> [options]
```

| Flag | Short | Purpose |
|------|-------|---------|
| `--description` | `-d` | Task description |
| `--ac` | | Acceptance criterion (repeatable) |
| `--labels` | `-l` | Comma-separated labels |
| `--assignee` | `-a` | Assign to user |
| `--priority` | | low/medium/high |
| `--parent` | | Parent task ID (raw ID only!) |

**`-a` = assignee, NOT acceptance criteria! Use `--ac` for AC.**

---

## task edit

```bash
knowns task edit <id> [options]
```

| Flag | Short | Purpose |
|------|-------|---------|
| `--status` | `-s` | Change status |
| `--assignee` | `-a` | Assign user |
| `--ac` | | Add acceptance criterion |
| `--check-ac` | | Mark AC done (1-indexed) |
| `--uncheck-ac` | | Unmark AC |
| `--plan` | | Set implementation plan |
| `--notes` | | Replace notes |
| `--append-notes` | | Add to notes |

---

## task view/list

```bash
knowns task <id> --plain
knowns task list --plain
knowns task list --status in-progress --plain
knowns task list --tree --plain
```

---

## doc create

```bash
knowns doc create <title> [options]
```

| Flag | Short | Purpose |
|------|-------|---------|
| `--description` | `-d` | Description |
| `--tags` | `-t` | Comma-separated tags |
| `--folder` | `-f` | Folder path |

---

## doc edit

```bash
knowns doc edit <name> [options]
```

| Flag | Short | Purpose |
|------|-------|---------|
| `--content` | `-c` | Replace content |
| `--append` | `-a` | Append content |
| `--section` | | Target section (use with -c) |

**In doc edit, `-a` = append content, NOT assignee!**

---

## doc view/list

**ALWAYS use `--smart`** - auto-handles small/large docs:

```bash
knowns doc <path> --plain --smart
```

If large, returns TOC. Then read section:
```bash
knowns doc <path> --plain --section 3
```

```bash
knowns doc list --plain
knowns doc list --tag api --plain
```

---

## time

```bash
knowns time start <id>    # REQUIRED when taking task
knowns time stop          # REQUIRED when completing
knowns time status
knowns time add <id> <duration> -n "Note"
```

---

## search

```bash
knowns search "query" --plain
knowns search "auth" --type task --plain
knowns search "api" --type doc --plain
```

---

## template

```bash
knowns template list
knowns template info <name>
knowns template run <name> --name "X" --dry-run
knowns template create <name>
```

---

## Multi-line Input

```bash
knowns task edit <id> --plan $'1. Step\n2. Step\n3. Step'
```

---

# Task Creation

## Before Creating

### CLI
```bash
# Search for existing tasks first
knowns search "keyword" --type task --plain
```
### MCP
```json
// Search for existing tasks first
mcp__knowns__search_tasks({ "query": "keyword" })
```

---

## Create Task

### CLI
```bash
knowns task create "Clear title (WHAT)" \
  -d "Description (WHY)" \
  --ac "Outcome 1" \
  --ac "Outcome 2" \
  --priority medium \
  -l "labels"
```
### MCP
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

### CLI
```bash
knowns task create "Parent task"
knowns task create "Subtask" --parent 48  # Raw ID only!
```
### MCP
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

### CLI
```bash
knowns task edit <id> -s in-progress -a @me
knowns time start <id>    # REQUIRED!
```
### MCP
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

### CLI
```bash
# Read task and follow ALL refs
knowns task <id> --plain
# @doc/xxx → knowns doc "xxx" --plain
# @task-YY → knowns task YY --plain

# Search related docs
knowns search "keyword" --type doc --plain

# Check similar done tasks
knowns search "keyword" --type task --status done --plain
```
### MCP
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

### CLI
```bash
knowns task edit <id> --plan $'1. Research (see @doc/xxx)
2. Implement
3. Test
4. Document'
```
### MCP
```json
mcp__knowns__update_task({
  "taskId": "<id>",
  "plan": "1. Research (see @doc/xxx)\n2. Implement\n3. Test\n4. Document"
})
```

**Share plan with user. WAIT for approval before coding.**

---

## Step 4: Implement

### CLI
```bash
# Check AC only AFTER work is done
knowns task edit <id> --check-ac 1
knowns task edit <id> --append-notes "Done: feature X"
```
### MCP
```json
// Check AC only AFTER work is done
mcp__knowns__update_task({
  "taskId": "<id>",
  "checkAc": [1],
  "appendNotes": "Done: feature X"
})
```

---

## Scope Changes

If new requirements emerge during work:

### CLI
```bash
# Small: Add to current task
knowns task edit <id> --ac "New requirement"
knowns task edit <id> --append-notes "Scope updated: reason"

# Large: Ask user first, then create follow-up
knowns task create "Follow-up: feature" -d "From task <id>"
```
### MCP
```json
// Small: Add to current task
mcp__knowns__update_task({
  "taskId": "<id>",
  "addAc": ["New requirement"],
  "appendNotes": "Scope updated: reason"
})

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

### CLI
| Requirement | Command |
|-------------|---------|
| All AC checked | `knowns task edit <id> --check-ac N` |
| Notes added | `knowns task edit <id> --notes "Summary"` |
| Timer stopped | `knowns time stop` |
| Status = done | `knowns task edit <id> -s done` |
| Tests pass | Run test suite |
### MCP
| Requirement | How |
|-------------|-----|
| All AC checked | `mcp__knowns__update_task` with `checkAc` |
| Notes added | `mcp__knowns__update_task` with `notes` |
| Timer stopped | `mcp__knowns__stop_time` |
| Status = done | `mcp__knowns__update_task` with `status: "done"` |
| Tests pass | Run test suite |

---

## Completion Steps

### CLI
```bash
# 1. Verify all AC are checked
knowns task <id> --plain

# 2. Add implementation notes
knowns task edit <id> --notes $'## Summary
What was done and key decisions.'

# 3. Stop timer (REQUIRED!)
knowns time stop

# 4. Mark done
knowns task edit <id> -s done
```
### MCP
```json
// 1. Verify all AC are checked
mcp__knowns__get_task({ "taskId": "<id>" })

// 2. Add implementation notes
mcp__knowns__update_task({
  "taskId": "<id>",
  "notes": "## Summary\nWhat was done and key decisions."
})

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

### CLI
```bash
knowns task edit <id> -s in-progress    # Reopen
knowns time start <id>                   # Restart timer
knowns task edit <id> --ac "Fix: description"
knowns task edit <id> --append-notes "Reopened: reason"
```
### MCP
```json
// 1. Reopen task
mcp__knowns__update_task({
  "taskId": "<id>",
  "status": "in-progress"
})

// 2. Restart timer
mcp__knowns__start_time({ "taskId": "<id>" })

// 3. Add AC for the fix
mcp__knowns__update_task({
  "taskId": "<id>",
  "addAc": ["Fix: description"],
  "appendNotes": "Reopened: reason"
})
```

Then follow completion steps again.

---

## Checklist

### CLI
- [ ] All AC checked (`--check-ac`)
- [ ] Notes added (`--notes`)
- [ ] Timer stopped (`time stop`)
- [ ] Tests pass
- [ ] Status = done (`-s done`)
### MCP
- [ ] All AC checked (`checkAc`)
- [ ] Notes added (`notes`)
- [ ] Timer stopped (`mcp__knowns__stop_time`)
- [ ] Tests pass
- [ ] Status = done (`mcp__knowns__update_task`)

---

# Common Mistakes

## CRITICAL: The -a Flag

| Command | `-a` Means | NOT This! |
|---------|------------|-----------|
| `task create/edit` | `--assignee` | ~~acceptance criteria~~ |
| `doc edit` | `--append` | ~~assignee~~ |

```bash
# WRONG (sets assignee to garbage!)
knowns task edit 35 -a "Criterion text"

# CORRECT (use --ac)
knowns task edit 35 --ac "Criterion text"
```

---

## CRITICAL: Notes vs Append Notes

**NEVER use `notes`/`--notes` for progress updates - it REPLACES all existing notes!**

```bash
# ❌ WRONG - Destroys audit trail!
knowns task edit <id> --notes "Done: feature X"

# ✅ CORRECT - Preserves history
knowns task edit <id> --append-notes "Done: feature X"
```
```json
// ❌ WRONG - Destroys audit trail!
mcp__knowns__update_task({
  "taskId": "<id>",
  "notes": "Done: feature X"
})

// ✅ CORRECT - Preserves history
mcp__knowns__update_task({
  "taskId": "<id>",
  "appendNotes": "Done: feature X"
})
```

| Field | Behavior |
|-------|----------|
| `--notes` | **REPLACES** all notes (use only for initial setup) |
| `--append-notes` | **APPENDS** to existing notes (use for progress) |
| `notes` | **REPLACES** all notes (use only for initial setup) |
| `appendNotes` | **APPENDS** to existing notes (use for progress) |

---

## Quick Reference

| DON'T | DO |
|-------|-----|
| Edit .md files directly | Use CLI commands |
| `-a "criterion"` | `--ac "criterion"` |
| `--parent task-48` | `--parent 48` (raw ID) |
| `--plain` with create/edit | `--plain` only for view/list |
| `--notes` for progress | `--append-notes` for progress |
| Edit .md files directly | Use MCP tools |
| `notes` for progress | `appendNotes` for progress |
| Check AC before work done | Check AC AFTER work done |
| Code before plan approval | Wait for user approval |
| Code before reading docs | Read docs FIRST |
| Skip time tracking | Always start/stop timer |
| Ignore refs | Follow ALL `@task-xxx`, `@doc/xxx`, `@template/xxx` refs |

---

## MCP Task Operations

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

---

## Template Syntax Pitfalls

When writing `.hbs` templates, **NEVER** create `$` followed by triple-brace - Handlebars interprets triple-brace as unescaped output:

```
// ❌ WRONG - Parse error!
this.logger.log(`Created: $` + `{` + `{` + `{camelCase entity}.id}`);

// ✅ CORRECT - Add space between ${ and double-brace, use ~ to trim whitespace
this.logger.log(`Created: ${ {{~camelCase entity~}}.id}`);
```

| DON'T | DO |
|-------|-----|
| `$` + triple-brace | `${ {{~helper~}}}` (space + escaped) |

**Rules:**
- Add space between `${` and double-brace
- Use `~` (tilde) to trim whitespace in output
- Escape literal braces with backslash

---

## Error Recovery

| Problem | Solution |
|---------|----------|
| Set assignee to AC text | `knowns task edit <id> -a @me` |
| Forgot to stop timer | `knowns time add <id> <duration>` |
| Checked AC too early | `knowns task edit <id> --uncheck-ac N` |
| Task not found | `knowns task list --plain` |
| Replaced notes by mistake | Cannot recover - notes are lost. Use `--append-notes` next time |
| Forgot to stop timer | `mcp__knowns__add_time` with duration |
| Wrong status | `mcp__knowns__update_task` to fix |
| Task not found | `mcp__knowns__list_tasks` to find ID |
| Need to uncheck AC | `mcp__knowns__update_task` with `uncheckAc: [N]` |
| Checked AC too early | `mcp__knowns__update_task` with `uncheckAc: [N]` |
| Replaced notes by mistake | Cannot recover - notes are lost. Use `appendNotes` next time |

---

# Claude Code Agents

When using Claude Code's Task tool, you can leverage Knowns MCP tools for task management and coordination. This section defines specialized agent patterns for parallel execution.

## Agent Patterns

### knowns-researcher

**Purpose**: Research and gather context before planning/coding.

**Capabilities**:
- Use Task(subagent_type="Explore") for codebase exploration
- Use `mcp__knowns__get_doc` to read project documentation
- Use `mcp__knowns__search_docs` to find relevant docs
- Use `mcp__knowns__get_task` to understand task requirements

**When to spawn**:
- Before starting a new task
- When exploring unfamiliar parts of codebase
- When gathering context for planning

**Example**:
```
Task(
  subagent_type="Explore",
  description="Research timer implementation",
  prompt="You are knowns-researcher. Use Knowns MCP tools to:
    1. Read task details: mcp__knowns__get_task({taskId: '...'})
    2. Search related docs: mcp__knowns__search_docs({query: 'timer'})
    3. Explore codebase for timer files
    Return: Summary of findings, relevant files, key patterns"
)
```

---

### knowns-planner

**Purpose**: Create implementation plans and define acceptance criteria.

**Capabilities**:
- Use Task(subagent_type="Plan") for architectural planning
- Use `mcp__knowns__update_task` to set plan and ACs
- Use `mcp__knowns__create_task` for subtasks

**When to spawn**:
- After research phase
- When task needs structured implementation plan
- When breaking down complex tasks

**Example**:
```
Task(
  subagent_type="Plan",
  description="Plan multi-timer implementation",
  prompt="You are knowns-planner. Based on research:
    1. Design implementation approach
    2. Create subtasks if needed: mcp__knowns__create_task
    3. Update task with plan: mcp__knowns__update_task({taskId, plan: '...'})
    4. Add acceptance criteria
    Return: Implementation plan with steps"
)
```

---

### knowns-coder

**Purpose**: Implement code and track progress.

**Capabilities**:
- Use Task(subagent_type="general-purpose") for implementation
- Use `mcp__knowns__update_task` to check ACs and add notes
- Use `mcp__knowns__start_time` / `mcp__knowns__stop_time` for tracking

**When to spawn**:
- After plan is approved
- For focused implementation of specific features
- When working on independent subtasks

**Example**:
```
Task(
  subagent_type="general-purpose",
  description="Implement timer data model",
  prompt="You are knowns-coder. Implement step 1 of the plan:
    1. Start timer: mcp__knowns__start_time({taskId: '...'})
    2. Implement the code changes
    3. Update progress: mcp__knowns__update_task({taskId, checkAc: [1], appendNotes: 'Done: ...'})
    4. Stop timer when done
    Return: Summary of changes made"
)
```

---

## Parallel Execution

Launch multiple agents in a SINGLE message for parallel work:

### Research Phase (Parallel)

```
// Launch 3 researchers in parallel:
Task(subagent_type="Explore", prompt="knowns-researcher: Find all timer-related files")
Task(subagent_type="Explore", prompt="knowns-researcher: Read time tracking docs")
Task(subagent_type="Explore", prompt="knowns-researcher: Find UI components for time display")
```

### Implementation Phase (Parallel Subtasks)

```
// After creating subtasks, implement in parallel:
Task(subagent_type="general-purpose", prompt="knowns-coder: Implement subtask task-1.1")
Task(subagent_type="general-purpose", prompt="knowns-coder: Implement subtask task-1.2")
```

### Coordination via Knowns

- Agents share state through Knowns MCP tools
- Use task notes for communication between agents
- Use task status for progress tracking
- Use labels for categorization

---

## Multi-Timer Support

Multiple concurrent timers are supported (one per task):

```bash
# Start timers for multiple tasks
knowns time start task-1
knowns time start task-2
knowns time status  # Shows both

# Stop specific timer
knowns time stop task-1

# Stop all timers
knowns time stop --all
```

Via MCP:
```json
mcp__knowns__start_time({ "taskId": "1" })
mcp__knowns__start_time({ "taskId": "2" })
mcp__knowns__stop_time({ "taskId": "1" })
```

---

## Task ID Normalization

Both formats are supported everywhere:

```bash
# These are equivalent:
knowns task 42 --plain
knowns task task-42 --plain

knowns time start 42
knowns time start task-42
```

Via MCP:
```json
mcp__knowns__get_task({ "taskId": "42" })
mcp__knowns__get_task({ "taskId": "task-42" })  // Same result
```
<!-- KNOWNS GUIDELINES END -->