<!-- KNOWNS GUIDELINES START -->
# Knowns CLI Guidelines

You MUST follow these rules. If you cannot follow any rule, stop and ask for guidance before proceeding.

## Core Rules

| Rule | Description |
|------|-------------|
| **CLI Only** | Use CLI commands for ALL operations. NEVER edit .md files directly |
| **Docs First** | Read project docs BEFORE planning or coding |
| **Time Tracking** | Always `time start` when taking task, `time stop` when done |
| **--plain Flag** | Use `--plain` ONLY for view/list/search commands (NOT create/edit) |

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
```bash
knowns doc list --plain
knowns doc "README" --plain
knowns doc "ARCHITECTURE" --plain
knowns doc "CONVENTIONS" --plain
```

### Task Lifecycle

**1. Create & Take**
```bash
knowns task create "Title" -d "Description" --priority high -l "label1,label2"
knowns task edit <id> -s in-progress -a @me
knowns time start <id>
```

**2. Research**
```bash
knowns task <id> --plain              # Follow ALL refs
knowns search "keyword" --type doc --plain
knowns doc "path/name" --plain
knowns search "keyword" --type task --status done --plain
```

**3. Plan → Wait approval**
```bash
knowns task edit <id> --plan $'1. Step (see @doc/xxx)\n2. Step'
```

**4. Implement**
```bash
knowns task edit <id> --append-notes "✓ Completed: feature X"
```

**5. Complete**
```bash
knowns time stop
knowns task edit <id> -s done
```

---

## Commands Quick Reference

### Tasks
```bash
knowns task create "Title" -d "Desc" --priority high -l "labels" --parent <id>
knowns task <id> --plain
knowns task edit <id> -s <status> -a @me
knowns task edit <id> --plan "..." --notes "..." --append-notes "..."
knowns task edit <id> --check-ac 1 --check-ac 2
knowns task list --plain
knowns task list --status in-progress --plain
knowns search "query" --type task --plain
```

### Time
```bash
knowns time start <id>
knowns time stop
knowns time add <id> 2h -n "Note"
knowns time status
knowns time report --from "2025-01-01" --to "2025-12-31"
```

### Docs
```bash
knowns doc list --plain
knowns doc "path/name" --plain
knowns doc create "Title" -d "Desc" -t "tags" -f "folder"
knowns doc edit "name" -c "content"
knowns doc edit "name" -a "append content"
knowns search "query" --type doc --plain
```

---

## Task IDs

| Format | Example | Notes |
|--------|---------|-------|
| Sequential | `48`, `49` | Legacy numeric |
| Hierarchical | `48.1`, `48.2` | Legacy subtasks |
| Random | `qkh5ne` | Current (6-char) |

**Subtasks:** Use raw ID — `--parent 48` not `--parent task-48`

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
| Edit .md directly | Use CLI commands |
| Skip timer | Always start/stop |
| Code before docs | Read docs first |
| Code before approval | Wait for approval |
| `--parent task-48` | `--parent 48` |
| Ignore refs | Follow ALL refs |
| `--plain` with create/edit | `--plain` only for view/list/search |

---

## Definition of Done

- [ ] Work completed
- [ ] Notes added
- [ ] Timer stopped
- [ ] Tests passing
- [ ] Docs updated
- [ ] Status: done
<!-- KNOWNS GUIDELINES END -->
