# Knowns Guidelines

> These rules are NON-NEGOTIABLE. Violating them causes data corruption.

{{#if mcp}}
## Session Init (Required)

```json
mcp__knowns__project({ "action": "detect" })
mcp__knowns__project({ "action": "set", "projectRoot": "/path/to/project" })
```

**Skip this = tools fail or work on wrong project.**
{{/if}}

---

## Critical Rules

{{#if mcp}}
{{#if cli}}
| Rule | Description |
|------|-------------|
| **Never edit .md** | Use MCP tools (preferred) or CLI. NEVER edit task/doc files directly |
| **Docs first** | Read project docs BEFORE planning or coding |
| **Plan → Approve → Code** | Share plan, WAIT for approval, then implement |
| **AC after work** | Only check acceptance criteria AFTER completing work |
| **Time tracking** | `start_time` when taking task, `stop_time` when done |
| **Validate** | Run `validate` before marking task done |
| **Decision impact** | Record `none` or a persisted first-class draft candidate before completion; never create Decision Memory |
| **appendNotes** | Use `appendNotes` for progress. `notes` REPLACES all (destroys history) |
{{else}}
| Rule | Description |
|------|-------------|
| **Never edit .md** | Use MCP tools. NEVER edit task/doc files directly |
| **Docs first** | Read project docs BEFORE planning or coding |
| **Plan → Approve → Code** | Share plan, WAIT for approval, then implement |
| **AC after work** | Only check acceptance criteria AFTER completing work |
| **Time tracking** | `start_time` when taking task, `stop_time` when done |
| **Validate** | Run `validate` before marking task done |
| **Decision impact** | Record `none` or a persisted first-class draft candidate before completion; never create Decision Memory |
| **appendNotes** | Use `appendNotes` for progress. `notes` REPLACES all (destroys history) |
{{/if}}
{{else}}
{{#if cli}}
| Rule | Description |
|------|-------------|
| **Never edit .md** | Use CLI commands. NEVER edit task/doc files directly |
| **Docs first** | Read project docs BEFORE planning or coding |
| **Plan → Approve → Code** | Share plan, WAIT for approval, then implement |
| **AC after work** | Only check acceptance criteria AFTER completing work |
| **Time tracking** | `time start` when taking task, `time stop` when done |
| **Validate** | Run `knowns validate` before marking task done |
| **Decision impact** | Record `none` or a persisted first-class draft candidate before completion; never create Decision Memory |
| **--append-notes** | Use `--append-notes` for progress. `--notes` REPLACES all (destroys history) |
{{/if}}
{{/if}}

{{#if cli}}
---

## CLI Pitfalls

### The `-a` flag trap

| Command | `-a` means | NOT this |
|---------|------------|----------|
| `task create/edit` | `--assignee` | ~~acceptance criteria~~ |
| `doc edit` | `--append` | ~~assignee~~ |

```bash
# WRONG - sets assignee to garbage!
knowns task edit KN-4F7Q2M -a "Criterion text"

# CORRECT
knowns task edit KN-4F7Q2M --ac "Criterion text"
```

### --plain flag

**Only for view/list/search commands:**
```bash
knowns task <id> --plain      # ✓
knowns task list --plain      # ✓
knowns task create --plain    # ✗ ERROR
knowns task edit --plain      # ✗ ERROR
```

### Subtasks

```bash
knowns task create "Sub" --parent KN-4F7Q2M    # ✓ the ID as printed
knowns task create "Sub" --parent task-KN-4F7Q2M  # ✗ WRONG

# The hyphen inside KN-4F7Q2M is part of the ID. Never strip the prefix.
# Projects without settings.defaultTaskIdPrefix use plain IDs like 4f7q2m.
```
{{/if}}

---

## References

Tasks and docs can reference each other:

| Type | Format | Example |
|------|--------|---------|
| Task | `@task-<id>` | `@task-KN-4F7Q2M`, `@task-4f7q2m` |
| Doc | `@doc/<path>` | `@doc/guides/setup` |
| Template | `@template/<name>` | `@template/component` |

`<id>` is the ID exactly as Knowns printed it. When a project sets
`settings.defaultTaskIdPrefix`, that includes the prefix, so `@task-KN-4F7Q2M`
carries two hyphens: the first belongs to the ref form, the second to the ID.
Dropping either one breaks the reference.

**Always follow refs recursively** before planning.
