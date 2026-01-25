---
name: knowns.task.plan
description: Use when creating an implementation plan for a task
---

# Planning a Task

Take ownership, gather context, create implementation plan, and get user approval.

**Announce at start:** "I'm using the knowns.task.plan skill to plan task [ID]."

**Core principle:** GATHER CONTEXT → PLAN → WAIT FOR APPROVAL.

## The Process

### Step 1: View Task & Take Ownership

{{#if mcp}}
```json
mcp__knowns__get_task({ "taskId": "$ARGUMENTS" })
```

```json
mcp__knowns__update_task({
  "taskId": "$ARGUMENTS",
  "status": "in-progress",
  "assignee": "@me"
})
```

```json
mcp__knowns__start_time({ "taskId": "$ARGUMENTS" })
```
{{else}}
```bash
knowns task $ARGUMENTS --plain
knowns task edit $ARGUMENTS -s in-progress -a @me
knowns time start $ARGUMENTS
```
{{/if}}

**Timer is mandatory.** Time data is used for estimation.

### Step 2: Gather Context

**Follow all refs in task:**

{{#if mcp}}
```json
// @doc/<path> →
mcp__knowns__get_doc({ "path": "<path>", "smart": true })

// @task-<id> →
mcp__knowns__get_task({ "taskId": "<id>" })
```
{{else}}
```bash
# @doc/<path> →
knowns doc "<path>" --plain

# @task-<id> →
knowns task <id> --plain
```
{{/if}}

**Search for related context:**

{{#if mcp}}
```json
mcp__knowns__search_docs({ "query": "<keywords>" })
mcp__knowns__search_tasks({ "query": "<keywords>" })
```
{{else}}
```bash
knowns search "<keywords>" --type doc --plain
knowns search "<keywords>" --type task --status done --plain
```
{{/if}}

**Check for templates:**

```bash
knowns template list
```

### Step 3: Draft Implementation Plan

Structure your plan:

```markdown
## Implementation Plan

1. [Step] (see @doc/relevant-doc)
2. [Step] (use @template/xxx if available)
3. Add tests
4. Update documentation
```

**Plan guidelines:**
- Reference relevant docs with `@doc/<path>`
- Reference templates with `@template/<name>`
- Include testing step
- Include doc updates if needed
- Keep steps actionable and specific

### Step 4: Present to User

Show the plan and **ASK for approval**:

```markdown
Here's my implementation plan for task [ID]:

1. Step one (see @doc/xxx)
2. Generate boilerplate with @template/xxx
3. Customize implementation
4. Add unit tests
5. Update API docs

Shall I proceed with this plan?
```

**WAIT for explicit approval.**

### Step 5: Save Plan (after approval)

{{#if mcp}}
```json
mcp__knowns__update_task({
  "taskId": "$ARGUMENTS",
  "plan": "1. Step one (see @doc/xxx)\n2. Step two\n3. Add unit tests\n4. Update API docs",
  "appendNotes": "📋 Plan approved, starting implementation"
})
```
{{else}}
```bash
knowns task edit $ARGUMENTS --plan $'1. Step one (see @doc/xxx)
2. Step two
3. Add unit tests
4. Update API docs'
knowns task edit $ARGUMENTS --append-notes "📋 Plan approved, starting implementation"
```
{{/if}}

## Plan Quality Checklist

- [ ] Task ownership taken (status: in-progress)
- [ ] Timer started
- [ ] All refs followed
- [ ] Related docs/tasks searched
- [ ] Templates identified (if any)
- [ ] Steps are specific and actionable
- [ ] Includes relevant doc/template references
- [ ] Includes testing
- [ ] User has approved

## Next Step

After plan is approved:

```
/knowns.task.implement $ARGUMENTS
```

## When Plan Isn't Clear

If requirements are unclear or multiple approaches exist:

```
/knowns.task.brainstorm $ARGUMENTS
```

## Remember

- Take ownership and start timer first
- Gather context before planning
- Check for templates to use
- Never implement without approved plan
- Reference docs and templates in the plan
