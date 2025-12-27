# Command Reference

Complete reference for all Knowns CLI commands.

## Task Commands

### `knowns task create`

Create a new task.

```bash
knowns task create "Title" [options]
```

| Option | Description |
|--------|-------------|
| `-d, --description` | Task description |
| `--ac` | Acceptance criterion (repeatable) |
| `-l, --labels` | Comma-separated labels |
| `--priority` | `low`, `medium`, `high` |
| `-a, --assignee` | Assignee (e.g., `@me`, `@john`) |
| `--parent` | Parent task ID for subtasks |

**Examples:**

```bash
# Basic task
knowns task create "Fix login bug"

# Task with details
knowns task create "Add authentication" \
  -d "Implement JWT auth following @doc/patterns/auth" \
  --ac "User can login" \
  --ac "Session persists" \
  --priority high \
  -l "feature,auth"

# Subtask
knowns task create "Write unit tests" --parent 42
```

### `knowns task list`

List all tasks.

```bash
knowns task list [options]
```

| Option | Description |
|--------|-------------|
| `--status` | Filter by status |
| `--priority` | Filter by priority |
| `--assignee` | Filter by assignee |
| `--label` | Filter by label |
| `--tree` | Show as tree hierarchy |
| `--plain` | Plain text output (for AI) |

**Examples:**

```bash
knowns task list --plain
knowns task list --status in-progress --assignee @me
knowns task list --tree --plain
```

### `knowns task view`

View a single task.

```bash
knowns task view <id> [options]
```

| Option | Description |
|--------|-------------|
| `--plain` | Plain text output (for AI) |
| `--json` | JSON output |

### `knowns task edit`

Edit an existing task.

```bash
knowns task edit <id> [options]
```

| Option | Description |
|--------|-------------|
| `-t, --title` | New title |
| `-d, --description` | New description |
| `-s, --status` | `todo`, `in-progress`, `in-review`, `blocked`, `done` |
| `--priority` | `low`, `medium`, `high` |
| `-a, --assignee` | Assignee |
| `-l, --labels` | Labels (replaces existing) |
| `--ac` | Add acceptance criterion |
| `--check-ac` | Check criterion (1-indexed) |
| `--uncheck-ac` | Uncheck criterion |
| `--remove-ac` | Remove criterion |
| `--plan` | Set implementation plan |
| `--notes` | Set implementation notes |
| `--append-notes` | Append to notes |

**Examples:**

```bash
# Change status and assignee
knowns task edit 42 -s in-progress -a @me

# Check acceptance criteria
knowns task edit 42 --check-ac 1 --check-ac 2

# Add implementation plan
knowns task edit 42 --plan $'1. Research\n2. Implement\n3. Test'

# Add notes progressively
knowns task edit 42 --append-notes "Completed auth middleware"
```

---

## Documentation Commands

### `knowns doc create`

Create a new document.

```bash
knowns doc create "Title" [options]
```

| Option | Description |
|--------|-------------|
| `-d, --description` | Document description |
| `-t, --tags` | Comma-separated tags |
| `-f, --folder` | Folder path (e.g., `patterns`, `architecture/api`) |

**Examples:**

```bash
# Simple doc
knowns doc create "API Guidelines" -d "REST API conventions"

# Doc in folder
knowns doc create "Auth Pattern" \
  -d "JWT authentication pattern" \
  -t "patterns,security" \
  -f patterns
```

### `knowns doc list`

List all documents.

```bash
knowns doc list [options]
```

| Option | Description |
|--------|-------------|
| `--tag` | Filter by tag |
| `--plain` | Plain text output |

### `knowns doc view`

View a document.

```bash
knowns doc view <name-or-path> [options]
```

| Option | Description |
|--------|-------------|
| `--plain` | Plain text output |

**Examples:**

```bash
knowns doc view "auth-pattern" --plain
knowns doc view "patterns/auth-pattern" --plain
```

### `knowns doc edit`

Edit a document.

```bash
knowns doc edit <name-or-path> [options]
```

| Option | Description |
|--------|-------------|
| `-t, --title` | New title |
| `--tags` | New tags |
| `-c, --content` | Replace content |
| `-a, --append` | Append to content |

---

## Time Tracking Commands

### `knowns time start`

Start tracking time on a task.

```bash
knowns time start <task-id>
```

### `knowns time stop`

Stop the current timer.

```bash
knowns time stop
```

### `knowns time pause` / `knowns time resume`

Pause or resume the current timer.

```bash
knowns time pause
knowns time resume
```

### `knowns time status`

Show current timer status.

```bash
knowns time status
```

### `knowns time add`

Add manual time entry.

```bash
knowns time add <task-id> <duration> [options]
```

| Option | Description |
|--------|-------------|
| `-n, --note` | Note for entry |
| `-d, --date` | Date (YYYY-MM-DD) |

**Examples:**

```bash
knowns time add 42 2h -n "Code review"
knowns time add 42 30m -d "2025-01-15"
```

### `knowns time report`

Generate time report.

```bash
knowns time report [options]
```

| Option | Description |
|--------|-------------|
| `--from` | Start date (YYYY-MM-DD) |
| `--to` | End date (YYYY-MM-DD) |
| `--by-label` | Group by label |
| `--csv` | CSV output |

---

## Search Commands

### `knowns search`

Search tasks and documentation.

```bash
knowns search <query> [options]
```

| Option | Description |
|--------|-------------|
| `--type` | `task` or `doc` |
| `--status` | Filter tasks by status |
| `--priority` | Filter tasks by priority |
| `--plain` | Plain text output |

---

## Other Commands

### `knowns init`

Initialize Knowns in current directory.

```bash
knowns init [project-name]
```

### `knowns browser`

Open Web UI in browser.

```bash
knowns browser [options]
```

| Option | Description |
|--------|-------------|
| `--port` | Custom port (default: 3456) |
| `--no-open` | Don't open browser |

### `knowns mcp`

Start MCP server for Claude Desktop.

```bash
knowns mcp
```

### `knowns agents`

Sync AI agent guidelines.

```bash
knowns agents --update-instructions
```

---

## Output Formats

### `--plain`

Plain text output optimized for AI consumption. Always use this when working with AI assistants.

```bash
knowns task view 42 --plain
knowns doc list --plain
knowns search "auth" --plain
```

### `--json`

JSON output for programmatic use.

```bash
knowns task view 42 --json
```

---

## Multi-line Input

### Bash / Zsh

```bash
knowns task edit 42 --plan $'1. Step one\n2. Step two\n3. Step three'
```

### PowerShell

```powershell
knowns task edit 42 --notes "Line 1`nLine 2`nLine 3"
```

### Heredoc (long content)

```bash
knowns task edit 42 --plan "$(cat <<EOF
1. Research existing patterns
2. Design solution
3. Implement
4. Write tests
5. Update documentation
EOF
)"
```
