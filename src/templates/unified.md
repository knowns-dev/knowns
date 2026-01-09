# Knowns Guidelines

You MUST follow these rules. If you cannot follow any rule, stop and ask for guidance before proceeding.

## Core Rules

| Rule | Description |
|------|-------------|
| **Never Edit .md** | Use CLI commands or MCP tools. NEVER edit .md files directly |
| **Docs First** | Read project docs BEFORE planning or coding |
| **Time Tracking** | Always start timer when taking task, stop when done |
| **Plan Approval** | Share plan with user, WAIT for approval before coding |
| **MCP → CLI Fallback** | If an MCP tool is missing, run the equivalent CLI command instead |

---

## Reference System

| Context | Task Format | Doc Format |
|---------|-------------|------------|
| **Writing** (input) | `@task-<id>` | `@doc/<path>` |
| **Reading** (output) | `@.knowns/tasks/task-<id> - Title.md` | `@.knowns/docs/<path>.md` |

When reading refs in output, extract ID/path and call appropriate tool. Follow refs recursively.

---

## Task IDs

| Format | Example | Notes |
|--------|---------|-------|
| Sequential | `48`, `49` | Legacy numeric |
| Hierarchical | `48.1`, `48.2` | Legacy subtasks |
| Random | `qkh5ne`, `a7f3k9` | Current (6-char base36) |

**Subtasks:** Use raw ID for parent (NOT "task-48")

---

## Workflow

### Session Start
1. List docs → Read README, ARCHITECTURE, CONVENTIONS
2. Review task backlog

### Task Lifecycle
1. **Take**: Set status `in-progress`, assign, start timer
2. **Research**: Get task details, follow ALL refs, search related docs
3. **Plan**: Create plan with doc refs → Wait for approval
4. **Implement**: Work step by step, append progress notes
5. **Complete**: Stop timer, set status `done`

### Post-Completion Changes
Reopen (in-progress) → Start timer → Document reason → Implement → Complete

---

## Command Reference

### Task Commands
| Action | CLI | MCP |
|--------|-----|-----|
| Create | `knowns task create "T" -d "D" --priority high` | `create_task({ title, description, priority })` |
| Create Subtask | `knowns task create "T" --parent 48` | `create_task({ title, parent: "48" })` |
| View | `knowns task <id> --plain` | `get_task({ taskId })` |
| List | `knowns task list --plain` | `list_tasks({})` |
| Update | `knowns task edit <id> -s done` | `update_task({ taskId, status: "done" })` |
| Search | `knowns search "q" --type task --plain` | `search_tasks({ query })` |

### Doc Commands
| Action | CLI | MCP |
|--------|-----|-----|
| List | `knowns doc list --plain` | `list_docs({})` |
| View | `knowns doc "path" --plain` | `get_doc({ path })` |
| Create | `knowns doc create "T" -d "D" -f "folder"` | `create_doc({ title, description, folder })` |
| Update | `knowns doc edit "name" -a "content"` | `update_doc({ path, appendContent })` |
| Search | `knowns search "q" --type doc --plain` | `search_docs({ query })` |

### Time Commands
| Action | CLI | MCP |
|--------|-----|-----|
| Start | `knowns time start <id>` | `start_time({ taskId })` |
| Stop | `knowns time stop` | `stop_time({ taskId })` |
| Add | `knowns time add <id> 2h -n "Note"` | `add_time({ taskId, duration, note })` |

---

## Status & Priority

| Status | Use When |
|--------|----------|
| `todo` | Not started (default) |
| `in-progress` | Currently working |
| `in-review` | PR submitted |
| `blocked` | Waiting on dependency |
| `done` | All criteria met |

| Priority | Description |
|----------|-------------|
| `low` | Nice-to-have |
| `medium` | Normal (default) |
| `high` | Urgent |

---

## CLI Notes

- Use `--plain` flag ONLY for view/list/search commands (NOT create/edit)
- Multi-line: `$'line1\nline2'` (bash) or heredoc

---

## Common Mistakes

| ❌ Wrong | ✅ Right |
|----------|----------|
| Edit .md files directly | Use CLI/MCP tools |
| Skip time tracking | Always start/stop timer |
| Code before reading docs | Read ALL related docs first |
| Code before plan approval | Wait for user approval |
| `--parent task-48` | `--parent 48` (raw ID only) |
| Ignore refs in task | Follow ALL refs recursively |
| `--plain` with create/edit | `--plain` only for view/list/search |

---

## Definition of Done

- [ ] All work completed and verified
- [ ] Implementation notes added
- [ ] Timer stopped
- [ ] Tests passing
- [ ] Documentation updated
- [ ] Status set to done
