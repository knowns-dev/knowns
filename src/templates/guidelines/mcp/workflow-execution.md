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

// @doc/xxx -> read the doc
mcp__knowns__get_doc({ "path": "xxx" })

// @task-YY -> read the task
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
