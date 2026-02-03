# Core Rules

> These rules are NON-NEGOTIABLE. Violating them leads to data corruption and lost work.

---

## The Golden Rule

{{#if mcp}}
{{#if cli}}
**If you want to change ANYTHING in a task or doc, use MCP tools (preferred) or CLI commands (fallback). NEVER edit .md files directly.**
{{else}}
**If you want to change ANYTHING in a task or doc, use MCP tools. NEVER edit .md files directly.**
{{/if}}
{{else}}
{{#if cli}}
**If you want to change ANYTHING in a task or doc, use CLI commands. NEVER edit .md files directly.**
{{/if}}
{{/if}}

{{#if mcp}}
---

## Session Initialization (MCP)

**CRITICAL: At the START of every session, run these tools to initialize the project:**

```json
// Step 1: Detect available projects
mcp__knowns__detect_projects({})

// Step 2: Set the project you want to work with
mcp__knowns__set_project({ "projectRoot": "/path/to/project" })

// Step 3: Verify project is set correctly
mcp__knowns__get_current_project({})
```

**Why?** The MCP server may not know which project you're working in. These tools:
- `detect_projects` - Scans common workspace directories for Knowns projects
- `set_project` - Sets the active project for all subsequent operations
- `get_current_project` - Verifies the current project path

**If you skip this step**, other tools like `list_tasks`, `get_doc`, etc. may fail or work on the wrong project.
{{/if}}

{{#if cli}}
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
{{/if}}

---

## Quick Reference

| Rule | Description |
|------|-------------|
{{#if mcp}}
{{#if cli}}
| **MCP Tools (preferred)** | Use MCP tools for ALL operations. Fallback to CLI if needed. NEVER edit .md files directly |
{{else}}
| **MCP Tools Only** | Use MCP tools for ALL operations. NEVER edit .md files directly |
{{/if}}
{{else}}
{{#if cli}}
| **CLI Only** | Use commands for ALL operations. NEVER edit .md files directly |
{{/if}}
{{/if}}
| **Docs First** | Read project docs BEFORE planning or coding |
| **Time Tracking** | Start timer when taking task, stop when done |
| **Plan Approval** | Share plan with user, WAIT for approval before coding |
| **Check AC After** | Only mark criteria done AFTER completing work |

{{#if cli}}
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
{{/if}}

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

{{#if cli}}
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
{{/if}}
{{#if mcp}}
### MCP
```json
mcp__knowns__create_task({
  "title": "Subtask title",
  "parent": "parent-task-id"
})
```

**CRITICAL:** Use raw ID (string) for all MCP tool calls.
{{/if}}
