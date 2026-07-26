---
title: User Guide
description: Comprehensive user documentation for Knowns CLI and Web UI
createdAt: '2025-12-29T11:49:48.531Z'
updatedAt: '2026-07-26T06:58:54.779Z'
tags:
  - docs
  - guide
  - user
---

# Knowns User Guide

Complete guide for using Knowns - a CLI-first knowledge layer and task management system for development teams.

---

## Getting Started

### Installation

```bash
# Install via npm (downloads platform-specific Go binary)
npm install -g knowns

# Install via Go
go install github.com/howznguyen/knowns/cmd/knowns@latest

# Install via curl (Linux/macOS)
curl -fsSL https://raw.githubusercontent.com/howznguyen/knowns/main/install/install.sh | sh

# Or use npx (no global install)
npx knowns <command>
```

### Initialize a Project

```bash
knowns init [project-name]
```

#### Interactive Wizard

The wizard prompts for 4 settings:

```
Knowns Project Setup Wizard
   Configure your project settings

? Project name > my-project
? Git tracking mode > Git Tracked (recommended for teams)
? AI Guidelines type > CLI
? Select AI agent files > CLAUDE.md, AGENTS.md

Project initialized: my-project
Created: CLAUDE.md
Created: AGENTS.md

Get started:
  knowns task create "My first task"
```

#### Wizard Options

| Option | Choices | Description |
|--------|---------|-------------|
| **Project name** | text | Your project name |
| **Git tracking mode** | `Git Tracked` / `Git Ignored` | Track all or only docs in git |
| **AI Guidelines type** | `CLI` / `MCP` | CLI commands or MCP tools |
| **AI agent files** | multiselect | Files to update |

#### MCP Mode

When selecting **MCP**, a `.mcp.json` file is auto-created for Claude Code:

```json
{
  "mcpServers": {
    "knowns": {
      "command": "knowns",
      "args": ["mcp"]
    }
  }
}
```

#### Skip Wizard

```bash
knowns init my-project --no-wizard
```

### Quick Start

```bash
knowns task create "Setup project" -d "Initial setup"
knowns task list
knowns browser  # Open Web UI
```

---

## CLI Commands

### Task Commands

#### Create Task
```bash
knowns task create "Title" [options]
```

| Option | Short | Description |
|--------|-------|-------------|
| `--description` | `-d` | Task description |
| `--ac` | | Acceptance criteria (repeatable) |
| `--labels` | `-l` | Comma-separated labels |
| `--priority` | | low / medium / high |
| `--parent` | `-p` | Parent task ID |

**Example:**
```bash
knowns task create "Add login" -d "User login feature" --ac "Form works" --ac "JWT stored" -l "auth" --priority high
```

#### View Task
```bash
knowns task <id> --plain
```

#### List Tasks
```bash
knowns task list --plain
knowns task list --status in-progress --plain
knowns task list --tree --plain
```

#### Edit Task
```bash
knowns task edit <id> -s in-progress
knowns task edit <id> --check-ac 1
knowns task edit <id> --append-notes "Progress update"
```

### Documentation Commands

#### Create Doc
```bash
knowns doc create "Title" -d "Description" -t "tags" -f "folder"
```

#### View Doc
```bash
knowns doc <path> --plain
```

#### Edit Doc
```bash
knowns doc edit "name" -c "New content"
knowns doc edit "name" -a "Appended content"
```

### Time Tracking

```bash
knowns time start <task-id>  # Start timer
knowns time stop             # Stop timer
knowns time pause            # Pause
knowns time resume           # Resume
knowns time status           # Check status
knowns time add <id> 2h      # Manual entry
knowns time report           # Generate report
```

### Search

```bash
knowns search "query" --plain
knowns search "auth" --type task --plain
knowns search "api" --type doc --plain
```

---

## Web UI

### Start

```bash
knowns browser
```

Opens `http://localhost:6420` with:
- **Kanban** - Visual task board
- **Tasks** - Table view
- **Docs** - Documentation browser
- **Config** - Settings

### Features

- Drag and drop tasks between columns
- Real-time sync with CLI
- Timer controls in task details
- Keyboard shortcuts (`⌘K` for search)

---

## MCP Integration

### Quick Setup

```bash
# Setup both project and Claude Code
knowns mcp setup

# Only create .mcp.json
knowns mcp setup --project

# Only add to Claude Code
knowns mcp setup --global
```

### Manual Setup (Claude Desktop)

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "knowns": {
      "command": "knowns",
      "args": ["mcp"]
    }
  }
}
```

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `create_task` | Create a new task |
| `get_task` | Get task by ID |
| `update_task` | Update task |
| `list_tasks` | List tasks |
| `search` | Unified search (tasks + docs) |
| `list_docs` | List documents |
| `get_doc` | Get document |
| `create_doc` | Create document |
| `update_doc` | Update document |
| `start_time` | Start timer |
| `stop_time` | Stop timer |
| `get_board` | Get kanban board |

### Plain Text Mode

Always use `--plain` for AI agents:
```bash
knowns task <id> --plain
knowns doc "path" --plain
```

---

## AI Guidelines

### View Guidelines

```bash
knowns agents guideline           # Default
knowns agents guideline --full    # All sections
knowns agents guideline --compact # Core + mistakes
```

### Sync to Files

```bash
knowns agents sync                # CLAUDE.md, AGENTS.md
knowns agents sync --all          # All files
knowns agents sync --type mcp     # MCP version
```

---

## Troubleshooting

### Diagnose with `knowns doctor`

Run `knowns doctor` before starting work, especially after cloning a repository that already contains `.knowns/`. This confirms whether the local machine has the required models, runtimes, language servers, indices, integration artifacts, and Knowns runtime-memory hooks before changes begin.

Start with the default offline, read-only diagnostic:

```bash
knowns doctor
```

The summary reports `healthy`, `degraded`, or `unhealthy`. Default output lists every warning and failure with remediation while keeping passing and skipped checks compact. Use verbose output when you need the complete human-readable trace:

```bash
knowns doctor --verbose
```

Use a scope when investigating one subsystem. Scopes can be comma-separated or repeated:

```bash
knowns doctor --scope project,validation
knowns doctor --scope search --scope runtime
knowns doctor --scope lsp --verbose
```

Doctor is offline unless you explicitly opt in. Online mode adds bounded version and configured embedding-provider connectivity probes; one failed probe does not suppress other findings:

```bash
knowns doctor --online
```

For CI and agents, use the complete JSON contract. `--strict` keeps the JSON verdict `degraded` but returns exit code 1 when warnings exist:

```bash
knowns doctor --json
knowns doctor --json --strict
```

Exit codes are 0 for healthy or non-strict degraded results, 1 for unhealthy or strict degraded results, and 2 when the diagnostic engine cannot produce a valid result. A directory without an active Knowns project returns a structured unhealthy result and recommends `knowns init`.

For configured or locally available Claude Code, Codex, Kiro, and OpenCode runtimes, doctor reports missing, disabled, or out-of-sync Knowns runtime-memory hooks as warnings. Each warning identifies the affected runtime and recommends `knowns runtime install <runtime>`.

Doctor does not apply fixes. Copy the remediation command from a finding, run it intentionally, and rerun doctor. Common examples include `knowns validate`, `knowns model download <model>`, `knowns search --reindex`, `knowns lsp install <language>`, `knowns runtime install <runtime>`, `knowns sync`, and `knowns update`.

| Error | Solution |
|-------|----------|
| "Not initialized" | Run `knowns doctor --scope project`, then `knowns init` |
| "Task not found" | Check ID with `knowns task list --plain` |
| "Timer already running" | Run `knowns time stop` first |
| Web UI won't start | Try `knowns browser --port 6421` |

### Help

```bash
knowns --help
knowns doctor --help
knowns task --help
```
