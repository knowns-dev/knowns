<!-- KNOWNS GUIDELINES START -->
# Knowns MCP - Gemini Quick Reference

## RULES
- NEVER edit .md files directly - use MCP tools only
- Read docs BEFORE coding
- Start timer when taking task, stop when done

## SESSION START
```
mcp__knowns__list_docs({})
mcp__knowns__get_doc({ path: "README" })
mcp__knowns__list_tasks({})
```

## TASK WORKFLOW

### 1. Take Task
```
mcp__knowns__get_task({ taskId: "<id>" })
mcp__knowns__update_task({ taskId: "<id>", status: "in-progress", assignee: "@me" })
mcp__knowns__start_time({ taskId: "<id>" })
```

### 2. Read Context
```
mcp__knowns__list_docs({ tag: "guides" })
mcp__knowns__get_doc({ path: "path/name" })
mcp__knowns__search_docs({ query: "keyword" })
```

### 3. Plan & Implement
```
mcp__knowns__update_task({ taskId: "<id>", description: "Updated with plan..." })
// Wait for approval, then code
mcp__knowns__update_task({ taskId: "<id>", labels: ["done-ac-1"] })
```

### 4. Complete
```
mcp__knowns__stop_time({ taskId: "<id>" })
mcp__knowns__update_task({ taskId: "<id>", status: "done" })
```

## MCP TOOLS CHEATSHEET

### Task
```
mcp__knowns__list_tasks({})
mcp__knowns__list_tasks({ status: "in-progress" })
mcp__knowns__get_task({ taskId: "<id>" })
mcp__knowns__create_task({ title: "Title", description: "Desc", priority: "high" })
mcp__knowns__update_task({ taskId: "<id>", status: "<status>", assignee: "@me" })
mcp__knowns__search_tasks({ query: "keyword" })
```

### Doc
```
mcp__knowns__list_docs({})
mcp__knowns__list_docs({ tag: "patterns" })
mcp__knowns__get_doc({ path: "name" })
mcp__knowns__create_doc({ title: "Title", description: "Desc", tags: ["tag1"] })
mcp__knowns__update_doc({ path: "name", content: "new content" })
mcp__knowns__update_doc({ path: "name", appendContent: "more content" })
mcp__knowns__search_docs({ query: "keyword" })
```

### Time
```
mcp__knowns__start_time({ taskId: "<id>" })
mcp__knowns__stop_time({ taskId: "<id>" })
mcp__knowns__add_time({ taskId: "<id>", duration: "2h", note: "Note" })
mcp__knowns__get_time_report({})
```

### Board
```
mcp__knowns__get_board({})
```

## REFS

### Reading (output format)
- `@.knowns/tasks/task-X - Title.md` → `mcp__knowns__get_task({ taskId: "X" })`
- `@.knowns/docs/path/name.md` → `mcp__knowns__get_doc({ path: "path/name" })`

### Writing (input format)
- Task: `@task-X`
- Doc: `@doc/path/name`

## STATUS & PRIORITY

**Status:** `todo`, `in-progress`, `in-review`, `blocked`, `done`
**Priority:** `low`, `medium`, `high`

## LONG CONTENT

For large docs, append in chunks:
```
# Create with initial content
mcp__knowns__create_doc({ title: "Title", content: "## Overview\n\nIntro." })

# Append sections
mcp__knowns__update_doc({ path: "name", appendContent: "## Section 1\n\n..." })
mcp__knowns__update_doc({ path: "name", appendContent: "## Section 2\n\n..." })
```
<!-- KNOWNS GUIDELINES END -->
