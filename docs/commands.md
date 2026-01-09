# Command Reference

Complete reference for all Knowns CLI commands.

## Task Commands

### `knowns task <id>` (Shorthand)

View a single task (shorthand for `knowns task view`).

```bash
knowns task <id> [options]
```

| Option | Description |
|--------|-------------|
| `--plain` | Plain text output (for AI) |

**Examples:**

```bash
knowns task 42 --plain
```

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

View a single task (full command form).

```bash
knowns task view <id> [options]
```

| Option | Description |
|--------|-------------|
| `--plain` | Plain text output (for AI) |

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

### `knowns task validate`

Validate a task file format.

```bash
knowns task validate <id> [options]
```

| Option | Description |
|--------|-------------|
| `--plain` | Plain text output |

### `knowns task repair`

Repair a corrupted task file.

```bash
knowns task repair <id> [options]
```

| Option | Description |
|--------|-------------|
| `--plain` | Plain text output |

---

## Documentation Commands

### `knowns doc <path>` (Shorthand)

View a document (shorthand for `knowns doc view`).

```bash
knowns doc <name-or-path> [options]
```

| Option | Description |
|--------|-------------|
| `--plain` | Plain text output (for AI) |

**Examples:**

```bash
knowns doc "README" --plain
knowns doc "patterns/auth" --plain
```

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
knowns doc list [path] [options]
```

| Argument | Description |
|----------|-------------|
| `[path]` | Filter by folder path (e.g., `guides/`, `patterns/`) |

| Option | Description |
|--------|-------------|
| `--tag` | Filter by tag |
| `--plain` | Plain text output (tree format, token-efficient) |

**Examples:**

```bash
# List all docs
knowns doc list

# List docs in specific folder
knowns doc list "guides/"
knowns doc list "patterns/" --plain

# Filter by tag
knowns doc list --tag architecture
```

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
| `--content-file <path>` | Replace content with file contents |
| `--append-file <path>` | Append file contents to document |

**Examples:**

```bash
# Edit content directly
knowns doc edit "README" -c "New content here"

# Append content
knowns doc edit "README" -a "## New Section"

# Use file for long content (useful on Windows)
knowns doc edit "README" --content-file ./new-content.md
knowns doc edit "README" --append-file ./additional-section.md
```

### `knowns doc validate`

Validate a documentation file format.

```bash
knowns doc validate <name> [options]
```

| Option | Description |
|--------|-------------|
| `--plain` | Plain text output |

### `knowns doc repair`

Repair a corrupted documentation file.

```bash
knowns doc repair <name> [options]
```

| Option | Description |
|--------|-------------|
| `--plain` | Plain text output |

### `knowns doc search-in`

Search text within a specific document.

```bash
knowns doc search-in <name> <query> [options]
```

| Option | Description |
|--------|-------------|
| `-i, --ignore-case` | Case insensitive search |
| `--plain` | Plain text output |

### `knowns doc replace`

Replace text in a document.

```bash
knowns doc replace <name> <old-text> <new-text> [options]
```

| Option | Description |
|--------|-------------|
| `-a, --all` | Replace all occurrences |
| `--plain` | Plain text output |

### `knowns doc replace-section`

Replace an entire section by its header.

```bash
knowns doc replace-section <name> <header> <content> [options]
```

| Option | Description |
|--------|-------------|
| `--plain` | Plain text output |

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

Initialize Knowns in current directory with interactive wizard.

**Requirement:** Git must be initialized first (`git init`).

```bash
knowns init [project-name] [options]
```

| Option | Description |
|--------|-------------|
| `--wizard` | Force interactive wizard mode |
| `--no-wizard` | Skip wizard, use defaults |
| `-f, --force` | Reinitialize (overwrites existing config) |

**Examples:**

```bash
# Interactive wizard (default when no name provided)
knowns init

# Quick init with name
knowns init my-project

# Force reinitialize
knowns init --force
```

**Wizard prompts:**
- Project name
- **Git tracking mode** (git-tracked or git-ignored)
- Default assignee
- Default priority
- Default labels
- Time format (12h/24h)
- AI guidelines version (CLI/MCP)
- AI agent files to sync (CLAUDE.md, GEMINI.md, etc.)

**Git Tracking Modes:**

| Mode | Description |
|------|-------------|
| `git-tracked` | All `.knowns/` files tracked in git (recommended for teams) |
| `git-ignored` | Only docs tracked, tasks/config ignored (personal use) |

When `git-ignored` is selected, Knowns automatically updates `.gitignore` to exclude task files while keeping docs tracked.

### `knowns config`

Manage project configuration.

```bash
knowns config <command> [key] [value]
```

**Commands:**

```bash
# Get a config value
knowns config get defaultAssignee --plain

# Set a config value
knowns config set defaultAssignee "@john"

# List all config
knowns config list
```

### `knowns browser`

Open Web UI in browser.

```bash
knowns browser [options]
```

| Option | Description |
|--------|-------------|
| `-p, --port` | Custom port (default: 6420) |
| `--no-open` | Don't open browser |

### `knowns mcp`

Start MCP server for Claude Desktop integration.

```bash
knowns mcp [options]
```

| Option | Description |
|--------|-------------|
| `--info` | Show configuration instructions |
| `--verbose` | Enable verbose logging |

**Examples:**

```bash
# Show setup instructions
knowns mcp --info

# Start server with logging
knowns mcp --verbose
```

### `knowns agents`

Manage AI agent instruction files and guidelines.

```bash
knowns agents [options]
```

| Option | Description |
|--------|-------------|
| (none) | Interactive mode - prompts to select type, variant, and files |
| `--update-instructions` | Non-interactive update |
| `--type <type>` | Guidelines type: `cli` or `mcp` (default: cli) |
| `--files <files>` | Comma-separated list of files to update |

**Supported files:**

| File | Description | Default |
|------|-------------|---------|
| `CLAUDE.md` | Claude Code instructions | ✓ |
| `AGENTS.md` | Agent SDK | ✓ |
| `GEMINI.md` | Google Gemini | |
| `.github/copilot-instructions.md` | GitHub Copilot | |

**Examples:**

```bash
# Interactive mode - select type, variant, and files
knowns agents

# Non-interactive update (uses defaults)
knowns agents --update-instructions

# Update specific files with MCP version
knowns agents --update-instructions --type mcp --files "CLAUDE.md,AGENTS.md"
```

### `knowns agents guideline`

Output guidelines to stdout. AI agents should call this at session start.

```bash
knowns agents guideline [options]
```

| Option | Description |
|--------|-------------|
| (none) | Output unified guidelines (CLI + MCP) |
| `--cli` | Output CLI-specific guidelines |
| `--mcp` | Output MCP-specific guidelines |

**Examples:**

```bash
# Output unified guidelines
knowns agents guideline

# CLI-specific
knowns agents guideline --cli

# MCP-specific
knowns agents guideline --mcp
```

### `knowns agents sync`

Quick sync of agent instruction files with latest guidelines.

```bash
knowns agents sync [options]
```

| Option | Description |
|--------|-------------|
| `--type <type>` | Guidelines type: `cli` or `mcp` (default: cli) |
| `--full` | Use full embedded guidelines (default: minimal instruction) |
| `--all` | Update all instruction files (including Gemini, Copilot) |

**Template variants:**

| Variant | Size | Description |
|---------|------|-------------|
| instruction (default) | ~600 bytes | Minimal - tells AI to call `knowns agents guideline` |
| general (`--full`) | ~4KB | Full guidelines embedded in file |

**Examples:**

```bash
# Sync default files (CLAUDE.md, AGENTS.md) with minimal instruction
knowns agents sync

# Sync all files
knowns agents sync --all

# Sync with full embedded guidelines
knowns agents sync --full

# Sync with MCP guidelines
knowns agents sync --type mcp
```

---

## Output Formats

### `--plain`

Plain text output optimized for AI consumption. Always use this when working with AI assistants.

```bash
knowns task 42 --plain
knowns doc list --plain
knowns search "auth" --plain
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
