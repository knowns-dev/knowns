<!-- KNOWNS GUIDELINES START -->
# Knowns CLI - Gemini Quick Reference

## RULES
- NEVER edit .md files directly - use CLI only
- Use `--plain` flag for VIEW/LIST/SEARCH commands only (NOT for create/edit)
- Read docs BEFORE coding
- Start timer when taking task, stop when done

## SESSION START
```bash
knowns doc list --plain
knowns doc "README" --plain
knowns task list --plain
```

## TASK WORKFLOW

### 1. Take Task
```bash
knowns task <id> --plain              # View task
knowns task edit <id> -s in-progress -a @me
knowns time start <id>
```

### 2. Read Context
```bash
knowns doc list "guides/" --plain     # List by folder
knowns doc "path/name" --plain        # View doc
knowns search "keyword" --type doc --plain
```

### 3. Plan & Implement
```bash
knowns task edit <id> --plan $'1. Step one\n2. Step two'
# Wait for approval, then code
knowns task edit <id> --check-ac 1    # Check criteria after done
knowns task edit <id> --append-notes "Done: feature X"
```

### 4. Complete
```bash
knowns time stop
knowns task edit <id> -s done
```

## COMMANDS CHEATSHEET

### Task
```bash
knowns task list --plain
knowns task list --status in-progress --plain
knowns task <id> --plain
knowns task create "Title" -d "Desc" --ac "Criterion" --priority high
knowns task edit <id> -s <status> -a @me
knowns task edit <id> --check-ac 1 --check-ac 2
knowns task edit <id> --plan "..."
knowns task edit <id> --notes "..."
knowns task edit <id> --append-notes "..."
```

### Doc
```bash
knowns doc list --plain
knowns doc list "folder/" --plain
knowns doc "name" --plain
knowns doc create "Title" -d "Desc" -t "tags" -f "folder"
knowns doc edit "name" -c "content"
knowns doc edit "name" -a "append"
knowns doc edit "name" --content-file ./file.md
knowns doc edit "name" --append-file ./file.md
knowns doc search-in "name" "query" --plain
knowns doc replace "name" "old" "new"
```

**Doc Organization:**
| Type | Location |
|------|----------|
| Core docs | Root `.knowns/docs/` (no -f flag) |
| Categorized | `.knowns/docs/<folder>/` (use -f flag) |

### Time
```bash
knowns time start <id>
knowns time stop
knowns time status
knowns time add <id> 2h -n "Note"
```

### Search
```bash
knowns search "query" --plain
knowns search "query" --type doc --plain
knowns search "query" --type task --plain
```

## REFS

### Reading (output format)
- `@.knowns/tasks/task-X - Title.md` → `knowns task X --plain`
- `@.knowns/docs/path/name.md` → `knowns doc "path/name" --plain`

### Writing (input format)
- Task: `@task-X`
- Doc: `@doc/path/name`

## STATUS & PRIORITY

**Status:** `todo`, `in-progress`, `in-review`, `blocked`, `done`
**Priority:** `low`, `medium`, `high`

## --plain FLAG

⚠️ **CRITICAL**: Only use `--plain` with VIEW/LIST/SEARCH commands!

| ✅ Supports --plain | ❌ NO --plain |
|---------------------|---------------|
| `task <id> --plain` | `task create` |
| `task list --plain` | `task edit` |
| `doc <path> --plain` | `doc create` |
| `doc list --plain` | `doc edit` |
| `search --plain` | `time start/stop/add` |

## LONG CONTENT

Windows has ~8191 char limit. Use:

```bash
# Append in chunks
knowns doc edit "name" -a "Section 1..."
knowns doc edit "name" -a "Section 2..."

# Or file-based
knowns doc edit "name" --content-file ./content.md
knowns doc edit "name" --append-file ./more.md
```

## VALIDATE & REPAIR

```bash
knowns doc validate "name" --plain
knowns doc repair "name" --plain
knowns task validate <id> --plain
knowns task repair <id> --plain
```
<!-- KNOWNS GUIDELINES END -->
