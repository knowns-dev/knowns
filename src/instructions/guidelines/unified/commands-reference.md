{{#if mcp}}
# MCP Tools Reference

## Task Tools

### mcp__knowns__create_task

```json
{
  "title": "Task title",
  "description": "Task description",
  "status": "todo",
  "priority": "medium",
  "labels": ["label1"],
  "assignee": "@me",
  "parent": "parent-id"
}
```

### mcp__knowns__update_task

```json
{
  "taskId": "<id>",
  "status": "in-progress",
  "assignee": "@me",
  "addAc": ["Criterion 1", "Criterion 2"],
  "checkAc": [1, 2],
  "uncheckAc": [3],
  "removeAc": [4],
  "plan": "1. Step one\n2. Step two",
  "notes": "Implementation notes",
  "appendNotes": "Additional notes"
}
```

| Field | Purpose |
|-------|---------|
| `addAc` | Add new acceptance criteria |
| `checkAc` | Mark AC done (1-based index) |
| `uncheckAc` | Unmark AC (1-based index) |
| `removeAc` | Remove AC (1-based index) |
| `plan` | Set implementation plan |
| `notes` | Replace implementation notes |
| `appendNotes` | Append to notes |

### mcp__knowns__get_task

```json
{ "taskId": "<id>" }
```

### mcp__knowns__list_tasks

```json
{ "status": "in-progress", "assignee": "@me" }
```

### mcp__knowns__search_tasks

```json
{ "query": "keyword" }
```

---

## Doc Tools

### mcp__knowns__get_doc

**ALWAYS use `smart: true`** - auto-handles small/large docs:

```json
{ "path": "readme", "smart": true }
```

If large, returns TOC. Then read section:
```json
{ "path": "readme", "section": "3" }
```

### mcp__knowns__list_docs

```json
{ "tag": "api" }
```

### mcp__knowns__create_doc

```json
{
  "title": "Doc Title",
  "description": "Description",
  "tags": ["tag1"],
  "folder": "guides",
  "content": "Initial content"
}
```

### mcp__knowns__update_doc

```json
{
  "path": "readme",
  "content": "Replace content",
  "section": "2"
}
```

### mcp__knowns__search_docs

```json
{ "query": "keyword", "tag": "api" }
```

### mcp__knowns__search (Unified)

```json
{
  "query": "keyword",
  "type": "all",
  "status": "in-progress",
  "priority": "high",
  "assignee": "@me",
  "label": "feature",
  "tag": "api",
  "limit": 20
}
```

| Field | Purpose |
|-------|---------|
| `type` | "all", "task", or "doc" |
| `status/priority/assignee/label` | Task filters |
| `tag` | Doc filter |
| `limit` | Max results (default: 20) |

---

## Time Tools

### mcp__knowns__start_time

```json
{ "taskId": "<id>" }
```

### mcp__knowns__stop_time

```json
{ "taskId": "<id>" }
```

### mcp__knowns__add_time

```json
{
  "taskId": "<id>",
  "duration": "2h30m",
  "note": "Note",
  "date": "2025-01-15"
}
```

### mcp__knowns__get_time_report

```json
{ "from": "2025-01-01", "to": "2025-01-31", "groupBy": "task" }
```

---

## Template Tools

### mcp__knowns__list_templates

```json
{}
```

### mcp__knowns__get_template

```json
{ "name": "template-name" }
```

### mcp__knowns__run_template

```json
{
  "name": "template-name",
  "variables": { "name": "MyComponent" },
  "dryRun": true
}
```

### mcp__knowns__create_template

```json
{
  "name": "my-template",
  "description": "Description",
  "doc": "patterns/my-pattern"
}
```

---

## Other

### mcp__knowns__get_board

```json
{}
```

{{else}}
# CLI Commands Reference

## task create

```bash
knowns task create <title> [options]
```

| Flag | Short | Purpose |
|------|-------|---------|
| `--description` | `-d` | Task description |
| `--ac` | | Acceptance criterion (repeatable) |
| `--labels` | `-l` | Comma-separated labels |
| `--assignee` | `-a` | Assign to user |
| `--priority` | | low/medium/high |
| `--parent` | | Parent task ID (raw ID only!) |

**`-a` = assignee, NOT acceptance criteria! Use `--ac` for AC.**

---

## task edit

```bash
knowns task edit <id> [options]
```

| Flag | Short | Purpose |
|------|-------|---------|
| `--status` | `-s` | Change status |
| `--assignee` | `-a` | Assign user |
| `--ac` | | Add acceptance criterion |
| `--check-ac` | | Mark AC done (1-indexed) |
| `--uncheck-ac` | | Unmark AC |
| `--plan` | | Set implementation plan |
| `--notes` | | Replace notes |
| `--append-notes` | | Add to notes |

---

## task view/list

```bash
knowns task <id> --plain
knowns task list --plain
knowns task list --status in-progress --plain
knowns task list --tree --plain
```

---

## doc create

```bash
knowns doc create <title> [options]
```

| Flag | Short | Purpose |
|------|-------|---------|
| `--description` | `-d` | Description |
| `--tags` | `-t` | Comma-separated tags |
| `--folder` | `-f` | Folder path |

---

## doc edit

```bash
knowns doc edit <name> [options]
```

| Flag | Short | Purpose |
|------|-------|---------|
| `--content` | `-c` | Replace content |
| `--append` | `-a` | Append content |
| `--section` | | Target section (use with -c) |

**In doc edit, `-a` = append content, NOT assignee!**

---

## doc view/list

**ALWAYS use `--smart`** - auto-handles small/large docs:

```bash
knowns doc <path> --plain --smart
```

If large, returns TOC. Then read section:
```bash
knowns doc <path> --plain --section 3
```

```bash
knowns doc list --plain
knowns doc list --tag api --plain
```

---

## time

```bash
knowns time start <id>    # REQUIRED when taking task
knowns time stop          # REQUIRED when completing
knowns time status
knowns time add <id> <duration> -n "Note"
```

---

## search

```bash
knowns search "query" --plain
knowns search "auth" --type task --plain
knowns search "api" --type doc --plain
```

---

## template

```bash
knowns template list
knowns template info <name>
knowns template run <name> --name "X" --dry-run
knowns template create <name>
```

---

## Multi-line Input

```bash
knowns task edit <id> --plan $'1. Step\n2. Step\n3. Step'
```
{{/if}}
