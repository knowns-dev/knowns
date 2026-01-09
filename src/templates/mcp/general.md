<!-- KNOWNS GUIDELINES START -->
# Knowns MCP Guidelines

You MUST follow these rules. If you cannot follow any rule, stop and ask for guidance before proceeding.

## Core Rules

| Rule | Description |
|------|-------------|
| **MCP Only** | Use MCP tools for ALL operations. NEVER edit .md files directly |
| **Docs First** | Read project docs BEFORE planning or coding |
| **Time Tracking** | Always `start_time` when taking task, `stop_time` when done |
| **Fallback to CLI** | If an MCP tool is missing, run the equivalent CLI command instead |

---

## Reference System

| Context | Task Format | Doc Format |
|---------|-------------|------------|
| **Writing** (input) | `@task-<id>` | `@doc/<path>` |
| **Reading** (output) | `@.knowns/tasks/task-<id>` | `@.knowns/docs/<path>.md` |

Follow refs recursively until complete context gathered.

---

## Workflow

### Session Start
```
list_docs({})
get_doc({ path: "README" })
get_doc({ path: "ARCHITECTURE" })
get_doc({ path: "CONVENTIONS" })
```

### Task Lifecycle

**1. Create & Take**
```
create_task({ title, description, priority, labels })
update_task({ taskId, status: "in-progress", assignee: "@username" })
start_time({ taskId })
```

**2. Research**
```
get_task({ taskId })              # Follow ALL refs
search_docs({ query })
get_doc({ path })
search_tasks({ query, status: "done" })
```

**3. Plan → Wait approval**
```
update_task({ taskId, plan: "1. Step (see @doc/xxx)\n2. Step" })
```

**4. Implement**
```
update_task({ taskId, appendNotes: "✓ Completed: feature X" })
```

**5. Complete**
```
stop_time({ taskId })
update_task({ taskId, status: "done" })
```

---

## Tools Quick Reference

### Tasks
- `create_task({ title, description, priority?, labels?, parent? })`
- `get_task({ taskId })`
- `update_task({ taskId, status?, plan?, notes?, appendNotes? })`
- `list_tasks({ status?, assignee?, label? })`
- `search_tasks({ query, status? })`

### Time
- `start_time({ taskId })`
- `stop_time({ taskId })`
- `add_time({ taskId, duration, note? })` — duration: "2h", "30m"
- `get_time_report({ from?, to?, groupBy? })`

### Docs
- `list_docs({ tag? })`
- `get_doc({ path })` — path without .md
- `create_doc({ title, description, tags?, folder?, content? })`
- `update_doc({ path, content?, appendContent? })`
- `search_docs({ query, tag? })`

---

## Task IDs

| Format | Example | Notes |
|--------|---------|-------|
| Sequential | `48`, `49` | Legacy numeric |
| Hierarchical | `48.1`, `48.2` | Legacy subtasks |
| Random | `qkh5ne` | Current (6-char) |

**Subtasks:** Use raw ID — `parent: "48"` not `parent: "task-48"`

---

## Status & Priority

| Status | When |
|--------|------|
| `todo` | Not started |
| `in-progress` | Working |
| `in-review` | PR submitted |
| `blocked` | Waiting |
| `done` | Complete |

| Priority | Level |
|----------|-------|
| `low` | Nice-to-have |
| `medium` | Normal |
| `high` | Urgent |

---

## Task Quality

**Title**: Clear action
❌ "Fix bug" → ✅ "Fix login timeout on slow networks"

**Description**: WHY + WHAT, link docs with `@doc/path`

**Acceptance**: Outcomes, not implementation
❌ "Add handleLogin()" → ✅ "User can login and receive token"

---

## Common Mistakes

| ❌ Wrong | ✅ Right |
|----------|----------|
| Edit .md directly | Use MCP tools |
| Skip timer | Always start/stop |
| Code before docs | Read docs first |
| Code before approval | Wait for approval |
| `parent: "task-48"` | `parent: "48"` |
| Ignore refs | Follow ALL refs |

---

## Definition of Done

- [ ] Work completed
- [ ] Notes added
- [ ] Timer stopped
- [ ] Tests passing
- [ ] Docs updated
- [ ] Status: done
<!-- KNOWNS GUIDELINES END -->
