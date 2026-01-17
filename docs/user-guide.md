# Knowns User Guide

Complete guide for using Knowns - a CLI-first knowledge layer and task management system for development teams.

---

## Getting Started

### Installation

```bash
# Install globally via npm
npm install -g knowns

# Or via npx (no installation)
npx knowns <command>
```

### Initialize a Project

```bash
# In your project directory
knowns init [project-name]
```

Running `knowns init` starts an interactive wizard:

```
🚀 Knowns Project Setup Wizard
   Configure your project settings

? Project name: my-project
? Git tracking mode: Git Tracked (recommended for teams)
? AI Guidelines type: CLI
? Select AI agent files to create/update:
  ◉ CLAUDE.md (Claude Code)
  ◉ AGENTS.md (Agent SDK)
  ◯ GEMINI.md (Google Gemini)
  ◯ .github/copilot-instructions.md (GitHub Copilot)
```

**Wizard Options:**

| Option | Choices | Description |
|--------|---------|-------------|
| **Project name** | Text | Name for your project |
| **Git tracking mode** | `git-tracked` / `git-ignored` | How tasks are tracked in git |
| **AI Guidelines type** | `CLI` / `MCP` | CLI commands or MCP tools format |
| **Agent files** | Multi-select | Which AI instruction files to create |

**What happens:**
- Creates `.knowns/` directory with `tasks/`, `docs/`, `config.json`
- If **MCP** selected: Creates `.mcp.json` for Claude Code auto-discovery
- If **git-ignored** selected: Updates `.gitignore` to exclude tasks
- Creates selected AI instruction files (CLAUDE.md, AGENTS.md, etc.)

**Quick init (skip wizard):**

```bash
# Use defaults with custom name
knowns init my-project --no-wizard

# Force reinitialize existing project
knowns init --force
```

### Quick Start

```bash
# Create your first task
knowns task create "Setup project" -d "Initial project setup"

# View all tasks
knowns task list

# Start the Web UI
knowns browser
```

---

## CLI Command Reference

### Task Commands

#### Create Task
```bash
knowns task create "Title" [options]
```

**Options:**
| Option | Short | Description |
|--------|-------|-------------|
| `--description` | `-d` | Task description |
| `--ac` | | Acceptance criteria (repeatable) |
| `--labels` | `-l` | Comma-separated labels |
| `--priority` | | low \| medium \| high |
| `--parent` | `-p` | Parent task ID |
| `--assignee` | `-a` | Assign to user (@me, @username) |

**Examples:**
```bash
knowns task create "Add login" -d "Implement user login" --ac "Login form works" --ac "JWT tokens stored" -l "auth,feature" --priority high
```

#### View Task
```bash
knowns task <id> [--plain]           # Shorthand
knowns task view <id> [--plain]      # Full command
```

- `--plain` - Plain text output (for AI agents)

#### List Tasks
```bash
knowns task list [options]
```

**Options:**
| Option | Description |
|--------|-------------|
| `--status` | Filter by status |
| `--assignee` | Filter by assignee |
| `--priority` | Filter by priority |
| `--label` | Filter by label |
| `--tree` | Show hierarchy tree |
| `--plain` | Plain text output |

**Examples:**
```bash
knowns task list --status in-progress --assignee @me
knowns task list --tree --plain
```

#### Edit Task
```bash
knowns task edit <id> [options]
```

**Options:**
| Option | Short | Description |
|--------|-------|-------------|
| `--title` | `-t` | Update title |
| `--description` | `-d` | Update description |
| `--status` | `-s` | Update status |
| `--priority` | | Update priority |
| `--assignee` | `-a` | Update assignee |
| `--ac` | | Add acceptance criterion |
| `--check-ac` | | Check AC by index (1-based) |
| `--uncheck-ac` | | Uncheck AC by index |
| `--remove-ac` | | Remove AC by index |
| `--plan` | | Set implementation plan |
| `--notes` | | Set implementation notes |
| `--append-notes` | | Append to notes |

**Examples:**
```bash
knowns task edit 42 -s in-progress -a @me
knowns task edit 42 --check-ac 1 --check-ac 2
knowns task edit 42 --append-notes "✓ Feature implemented"
```

### Documentation Commands

#### Create Document
```bash
knowns doc create "Title" [options]
```

**Options:**
| Option | Short | Description |
|--------|-------|-------------|
| `--description` | `-d` | Document description |
| `--tags` | `-t` | Comma-separated tags |
| `--folder` | `-f` | Folder path |

#### View Document
```bash
knowns doc <path> [--plain]          # Shorthand
knowns doc view "path/name" [--plain] # Full command
```

#### Edit Document
```bash
knowns doc edit "name" [options]
```

**Options:**
| Option | Short | Description |
|--------|-------|-------------|
| `--title` | `-t` | Update title |
| `--tags` | | Update tags |
| `--content` | `-c` | Replace content |
| `--append` | `-a` | Append to content |

#### List Documents
```bash
knowns doc list [--tag <tag>] [--plain]
```

### Time Tracking Commands

#### Start Timer
```bash
knowns time start <task-id>
```

#### Stop Timer
```bash
knowns time stop
```

#### Pause/Resume Timer
```bash
knowns time pause
knowns time resume
```

#### Check Timer Status
```bash
knowns time status
```

#### Add Manual Entry
```bash
knowns time add <task-id> <duration> [-n "note"] [-d "date"]
```

**Examples:**
```bash
knowns time add 42 2h -n "Code review"
knowns time add 42 30m -d "2025-12-25"
```

#### Generate Report
```bash
knowns time report [options]
```

**Options:**
| Option | Description |
|--------|-------------|
| `--from` | Start date (YYYY-MM-DD) |
| `--to` | End date (YYYY-MM-DD) |
| `--by-label` | Group by labels |
| `--csv` | Export as CSV |

### Search Commands

```bash
knowns search "query" [options]
```

**Options:**
| Option | Description |
|--------|-------------|
| `--type` | task \| doc |
| `--status` | Filter by status |
| `--priority` | Filter by priority |
| `--plain` | Plain text output |

---

## Web UI Guide

### Starting the Web UI

```bash
knowns browser
```

This opens `http://localhost:6420` in your browser.

### Navigation

The sidebar provides access to:
- **Kanban** - Visual task board
- **Tasks** - Table view of all tasks
- **Docs** - Documentation browser
- **Config** - Project settings

### Kanban Board

The Kanban board displays tasks in columns by status:
- **Todo** - Tasks not yet started
- **In Progress** - Tasks being worked on
- **In Review** - Tasks in code review
- **Blocked** - Tasks waiting on dependencies
- **Done** - Completed tasks

**Features:**
- Drag and drop tasks between columns
- Click task card to view details
- "New Task" button to create tasks
- "Batch Archive" to clean up old done tasks

### Task Details

Click any task to open the detail panel:
- View/edit title, description
- Check acceptance criteria
- Change status, priority, assignee
- View/add implementation notes
- Track time with timer controls

### Real-time Sync

The Web UI syncs in real-time with CLI changes:
- Tasks updated via CLI appear instantly
- Multiple browser tabs stay synchronized
- SSE connection for live updates (auto-reconnects on sleep/wake)

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `⌘K` / `Ctrl+K` | Open command search |
| `Esc` | Close dialogs |

---

## Time Tracking Guide

### Workflow

1. **Start work on a task:**
   ```bash
   knowns task edit 42 -s in-progress -a @me
   knowns time start 42
   ```

2. **Take a break:**
   ```bash
   knowns time pause
   # ... break ...
   knowns time resume
   ```

3. **Finish work:**
   ```bash
   knowns time stop
   knowns task edit 42 -s done
   ```

### Viewing Time Entries

```bash
# Check current timer
knowns time status

# View time report for this month
knowns time report --from "2025-12-01" --to "2025-12-31"

# Export to CSV
knowns time report --csv > report.csv
```

### Manual Entries

For time worked without the timer:
```bash
knowns time add 42 1h30m -n "Pair programming session"
```

---

## MCP Integration Guide (for AI Agents)

Knowns includes a Model Context Protocol (MCP) server for AI integration.

### Setup with Claude Code (Recommended)

```bash
# Auto setup - creates .mcp.json and configures Claude Code
knowns mcp setup

# Or during init, select "MCP" as AI Guidelines type
knowns init
# ? AI Guidelines type: MCP
# ✓ Created .mcp.json for Claude Code MCP auto-discovery
```

### Manual Setup with Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "knowns": {
      "command": "npx",
      "args": ["knowns", "mcp"]
    }
  }
}
```

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `get_task` | Get task details by ID |
| `list_tasks` | List tasks with filters |
| `create_task` | Create a new task |
| `update_task` | Update task fields |
| `get_doc` | Get document content |
| `list_docs` | List all documents |
| `search` | Search tasks and docs |

### Plain Text Mode

Always use `--plain` flag when AI agents call CLI commands:
```bash
knowns task 42 --plain
knowns task list --plain
knowns doc "README" --plain
```

### Reference System

Tasks and docs can reference each other:
- `@task-42` → Links to task 42
- `@doc/patterns/module` → Links to document

References maintain their simple format in all outputs.

### AI Guidelines Management

Get guidelines on-demand or sync instruction files:

```bash
# Output guidelines to stdout (AI agents call this at session start)
knowns agents guideline

# Interactive mode - select type, variant, files
knowns agents

# Quick sync (CLAUDE.md, AGENTS.md) with full guidelines
knowns agents sync

# Sync all files
knowns agents sync --all

# Sync with minimal instruction only
knowns agents sync --minimal

# Use MCP tools format
knowns agents sync --type mcp
```

**Template variants:**

| Variant | Size | Description |
|---------|------|-------------|
| general (default) | ~26KB | Full guidelines embedded in file |
| instruction (`--minimal`) | ~1KB | Minimal - tells AI to call `knowns agents guideline` |

---

## Troubleshooting

### Common Issues

#### "Error: Not initialized"
Run `knowns init` in your project directory first.

#### "Error: Task not found"
Check the task ID with `knowns task list --plain`.

#### "Error: Timer already running"
Stop the current timer with `knowns time stop` before starting a new one.

#### Web UI won't start
- Check if port 6420 is available
- Try `knowns browser --port 6421`

#### Tasks not syncing
- Refresh the browser
- Check SSE connection in browser dev tools
- Wait for auto-reconnection if computer was asleep

### Getting Help

```bash
# View help for any command
knowns --help
knowns task --help
knowns task create --help
```

### Debug Mode

For detailed logging:
```bash
DEBUG=knowns:* knowns <command>
```

### Report Issues

File issues at: https://github.com/knowns-dev/knowns/issues
