# CLI Commands Reference

Complete reference for all Knowns CLI commands.

---

## Task Commands

### task create

```
knowns task create <title> [options]
```

| Flag | Short | Purpose | Example |
|------|-------|---------|---------|
| `--description` | `-d` | Task description | `-d "Fix the login bug"` |
| `--ac` | | Acceptance criterion (repeatable) | `--ac "User can login"` |
| `--labels` | `-l` | Comma-separated labels | `-l "bug,urgent"` |
| `--assignee` | `-a` | Assign to user | `-a @username` |
| `--priority` | | low/medium/high | `--priority high` |
| `--status` | `-s` | Initial status | `-s todo` |
| `--parent` | | Parent task ID (raw ID only!) | `--parent 48` |

**Example:**
```bash
knowns task create "Fix login timeout" \
  -d "Users experience timeout on slow networks" \
  --ac "Login works on 3G connection" \
  --ac "Timeout increased to 30s" \
  -l "bug,auth" \
  --priority high
```

---

### task edit

```
knowns task edit <id> [options]
```

| Flag | Short | Purpose | Example |
|------|-------|---------|---------|
| `--title` | `-t` | Change title | `-t "New title"` |
| `--description` | `-d` | Change description | `-d "New desc"` |
| `--status` | `-s` | Change status | `-s in-progress` |
| `--priority` | | Change priority | `--priority high` |
| `--labels` | `-l` | Set labels | `-l "bug,urgent"` |
| `--assignee` | `-a` | Assign user ⚠️ | `-a @username` |
| `--parent` | | Move to parent | `--parent 48` |
| `--ac` | | Add acceptance criterion | `--ac "New criterion"` |
| `--check-ac` | | Mark AC done (1-indexed) | `--check-ac 1` |
| `--uncheck-ac` | | Unmark AC (1-indexed) | `--uncheck-ac 1` |
| `--remove-ac` | | Delete AC (1-indexed) | `--remove-ac 3` |
| `--plan` | | Set implementation plan | `--plan "1. Step one"` |
| `--notes` | | Replace notes | `--notes "Summary"` |
| `--append-notes` | | Add to notes | `--append-notes "✓ Done"` |

**⚠️ WARNING:** `-a` is assignee, NOT acceptance criteria! Use `--ac` for AC.

**Examples:**
```bash
# Take task
knowns task edit abc123 -s in-progress -a @me

# Add acceptance criteria (use --ac, NOT -a!)
knowns task edit abc123 --ac "Feature works offline"

# Check criteria as done (1-indexed)
knowns task edit abc123 --check-ac 1 --check-ac 2

# Add implementation plan
knowns task edit abc123 --plan $'1. Research\n2. Implement\n3. Test'

# Add progress notes
knowns task edit abc123 --append-notes "✓ Completed research phase"

# Complete task
knowns task edit abc123 -s done
```

---

### task view/list

```bash
# View single task (ALWAYS use --plain for AI)
knowns task <id> --plain
knowns task view <id> --plain

# List tasks
knowns task list --plain
knowns task list --status in-progress --plain
knowns task list --assignee @me --plain
knowns task list --tree --plain
```

---

## Doc Commands

### doc create

```
knowns doc create <title> [options]
```

| Flag | Short | Purpose | Example |
|------|-------|---------|---------|
| `--description` | `-d` | Description | `-d "API reference"` |
| `--tags` | `-t` | Comma-separated tags | `-t "api,reference"` |
| `--folder` | `-f` | Folder path | `-f "guides"` |

**Example:**
```bash
knowns doc create "API Reference" \
  -d "REST API documentation" \
  -t "api,docs" \
  -f "api"
```

---

### doc edit

```
knowns doc edit <name> [options]
```

| Flag | Short | Purpose | Example |
|------|-------|---------|---------|
| `--title` | `-t` | Change title | `-t "New Title"` |
| `--description` | `-d` | Change description | `-d "New desc"` |
| `--tags` | | Set tags | `--tags "new,tags"` |
| `--content` | `-c` | Replace content | `-c "New content"` |
| `--append` | `-a` | Append content ⚠️ | `-a "Added section"` |
| `--content-file` | | Content from file | `--content-file ./content.md` |
| `--append-file` | | Append from file | `--append-file ./more.md` |

**⚠️ NOTE:** In doc edit, `-a` means append content, NOT assignee!

**Examples:**
```bash
# Replace content
knowns doc edit "readme" -c "# New Content"

# Append content
knowns doc edit "readme" -a "## New Section"
```

---

### doc view/list

```bash
# View doc (ALWAYS use --plain for AI)
knowns doc <path> --plain
knowns doc view "<path>" --plain

# List docs
knowns doc list --plain
knowns doc list --tag api --plain
knowns doc list "guides/" --plain
```

---

## Time Commands

```bash
# Start timer (REQUIRED when taking task)
knowns time start <taskId>

# Stop timer (REQUIRED when completing task)
knowns time stop

# Pause/resume
knowns time pause
knowns time resume

# Check status
knowns time status

# Manual entry
knowns time add <taskId> <duration> -n "Note" -d "2025-01-01"
# duration: "2h", "30m", "1h30m"

# Report
knowns time report --from "2025-01-01" --to "2025-12-31"
```

---

## Search Commands

```bash
# Search everything
knowns search "query" --plain

# Search by type
knowns search "auth" --type task --plain
knowns search "api" --type doc --plain

# Filter by status/priority
knowns search "bug" --type task --status in-progress --priority high --plain
```

---

## Multi-line Input

Different shells handle multi-line strings differently:

**Bash/Zsh (ANSI-C quoting):**
```bash
knowns task edit <id> --plan $'1. Step one\n2. Step two\n3. Step three'
```

**PowerShell:**
```powershell
knowns task edit <id> --plan "1. Step one`n2. Step two`n3. Step three"
```

**Cross-platform (heredoc):**
```bash
knowns task edit <id> --plan "$(cat <<EOF
1. Step one
2. Step two
3. Step three
EOF
)"
```

---

## MCP Tools (Alternative to CLI)

| Action | MCP Tool |
|--------|----------|
| List tasks | `list_tasks({})` |
| Get task | `get_task({ taskId })` |
| Create task | `create_task({ title, description, priority, labels })` |
| Update task | `update_task({ taskId, status, assignee, plan, notes })` |
| Search tasks | `search_tasks({ query })` |
| List docs | `list_docs({})` |
| Get doc | `get_doc({ path })` |
| Create doc | `create_doc({ title, description, tags, folder })` |
| Update doc | `update_doc({ path, content, appendContent })` |
| Start timer | `start_time({ taskId })` |
| Stop timer | `stop_time({ taskId })` |

**Note:** MCP does NOT support acceptance criteria operations. Use CLI:
```bash
knowns task edit <id> --ac "criterion"
knowns task edit <id> --check-ac 1
```
