# Task Creation

## Before Creating

{{#if mcp}}
```json
// Search for existing tasks first
mcp__knowns__search_tasks({ "query": "keyword" })
```
{{else}}
```bash
# Search for existing tasks first
knowns search "keyword" --type task --plain
```
{{/if}}

---

## Create Task

{{#if mcp}}
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
{{else}}
```bash
knowns task create "Clear title (WHAT)" \
  -d "Description (WHY)" \
  --ac "Outcome 1" \
  --ac "Outcome 2" \
  --priority medium \
  -l "labels"
```
{{/if}}

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

{{#if mcp}}
```json
// Create parent first
mcp__knowns__create_task({ "title": "Parent task" })

// Then create subtask with parent ID
mcp__knowns__create_task({
  "title": "Subtask",
  "parent": "parent-task-id"
})
```
{{else}}
```bash
knowns task create "Parent task"
knowns task create "Subtask" --parent 48  # Raw ID only!
```
{{/if}}

---

## Anti-Patterns

- Too many AC in one task -> Split into multiple tasks
- Implementation steps as AC -> Write outcomes instead
- Skip search -> Always check existing tasks first
