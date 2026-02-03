# Task Execution

## Step 1: Take Task

{{#if cli}}
### CLI
```bash
knowns task edit <id> -s in-progress -a @me
knowns time start <id>    # REQUIRED!
```
{{/if}}
{{#if mcp}}
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
{{/if}}

---

## Step 2: Research

{{#if cli}}
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
{{/if}}
{{#if mcp}}
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
{{/if}}

---

## Step 3: Plan (BEFORE coding!)

{{#if cli}}
### CLI
```bash
knowns task edit <id> --plan $'1. Research (see @doc/xxx)
2. Implement
3. Test
4. Document'
```
{{/if}}
{{#if mcp}}
### MCP
```json
mcp__knowns__update_task({
  "taskId": "<id>",
  "plan": "1. Research (see @doc/xxx)\n2. Implement\n3. Test\n4. Document"
})
```
{{/if}}

**Share plan with user. WAIT for approval before coding.**

---

## Step 4: Implement

{{#if cli}}
### CLI
```bash
# Check AC only AFTER work is done
knowns task edit <id> --check-ac 1
knowns task edit <id> --append-notes "Done: feature X"
```
{{/if}}
{{#if mcp}}
### MCP
```json
// Check AC only AFTER work is done
mcp__knowns__update_task({
  "taskId": "<id>",
  "checkAc": [1],
  "appendNotes": "Done: feature X"
})
```
{{/if}}

---

## Scope Changes

If new requirements emerge during work:

{{#if cli}}
### CLI
```bash
# Small: Add to current task
knowns task edit <id> --ac "New requirement"
knowns task edit <id> --append-notes "Scope updated: reason"

# Large: Ask user first, then create follow-up
knowns task create "Follow-up: feature" -d "From task <id>"
```
{{/if}}
{{#if mcp}}
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
{{/if}}

**Don't silently expand scope. Ask user first.**

---

## Key Rules

1. **Plan before code** - Capture approach first
2. **Wait for approval** - Don't start without OK
3. **Check AC after work** - Not before
4. **Ask on scope changes** - Don't expand silently
