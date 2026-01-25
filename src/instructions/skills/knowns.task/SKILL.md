---
name: knowns.task
description: Use when working on a Knowns task - view task details and decide next action
---

# Working on a Task

View task details and determine the appropriate next action.

**Announce at start:** "I'm using the knowns.task skill to view task [ID]."

**Core principle:** VIEW AND ROUTE - analyze state, suggest next skill.

## The Process

### Step 1: View Task

{{#if mcp}}
```json
mcp__knowns__get_task({ "taskId": "$ARGUMENTS" })
```
{{else}}
```bash
knowns task $ARGUMENTS --plain
```
{{/if}}

### Step 2: Analyze State

Check:
- **Status**: todo, in-progress, done?
- **Assignee**: Assigned to someone?
- **AC**: Any checked? All checked?
- **Plan**: Has implementation plan?
- **Refs**: Any `@doc/` or `@task-` references?

### Step 3: Suggest Next Action

Based on task state, recommend the appropriate skill:

| State | Next Skill |
|-------|------------|
| `todo`, not started | `knowns.task.plan` |
| `in-progress`, no plan | `knowns.task.plan` |
| `in-progress`, has plan | `knowns.task.implement` |
| `done`, needs changes | `knowns.task.reopen` |
| Requirements unclear | `knowns.task.brainstorm` |

### Step 4: Follow Refs (if needed)

If task has references, follow them for context:

{{#if mcp}}
```json
// Doc ref: @doc/path →
mcp__knowns__get_doc({ "path": "<path>", "smart": true })

// Task ref: @task-<id> →
mcp__knowns__get_task({ "taskId": "<id>" })
```
{{else}}
```bash
# Doc ref: @doc/path →
knowns doc "<path>" --plain

# Task ref: @task-<id> →
knowns task <id> --plain
```
{{/if}}

## Quick Actions

**Start planning (includes taking ownership):**
```
/knowns.task.plan $ARGUMENTS
```

**Continue implementing:**
```
/knowns.task.implement $ARGUMENTS
```

**Requirements unclear:**
```
/knowns.task.brainstorm $ARGUMENTS
```

**Reopen completed task:**
```
/knowns.task.reopen $ARGUMENTS
```

## Remember

- This skill is for viewing and routing
- Use `plan` to start a new task (takes ownership, starts timer)
- Use `implement` to continue/complete in-progress tasks
- Always follow refs for full context
