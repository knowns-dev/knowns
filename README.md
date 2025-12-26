<p align="center">
  <img src="images/cover.png" alt="Knowns - Task & Documentation Management" width="100%">
</p>

<h1 align="center">Knowns</h1>

<p align="center">
  <strong>Know what your team knows.</strong>
</p>

<p align="center">
  CLI tool for dev teams to manage tasks and documentation with AI-first context linking.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/knowns"><img src="https://img.shields.io/npm/v/knowns.svg?style=flat-square" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/knowns"><img src="https://img.shields.io/npm/dm/knowns.svg?style=flat-square" alt="npm downloads"></a>
  <a href="https://github.com/knowns-dev/knowns/actions"><img src="https://img.shields.io/github/actions/workflow/status/knowns-dev/knowns/ci.yml?branch=main&style=flat-square&label=CI" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square" alt="License: MIT"></a>
</p>

---

## Why Knowns?

**Problem:** AI assistants lose context between sessions. You repeat the same architecture explanations, patterns, and decisions over and over.

**Solution:** Knowns links tasks to documentation with structured context that AI can understand and reference automatically.

## Features

| Feature | Description |
|---------|-------------|
| 🎯 **Task Management** | Create, track, and manage tasks with acceptance criteria |
| 📚 **Documentation** | Nested folder structure with markdown support |
| ⏱️ **Time Tracking** | Built-in timers and time reports |
| 🔗 **Context Linking** | `@task-42` and `@doc/patterns/auth` references |
| 🤖 **AI Integration** | MCP Server for Claude Desktop, `--plain` output for AI |
| 🌐 **Web UI** | Kanban board, document browser, dark mode |
| 🔄 **Agent Sync** | Sync guidelines to Claude, Gemini, Copilot |

## Installation

```bash
# Using npm
npm install -g knowns

# Using bun
bun install -g knowns
```

## Quick Start

```bash
# Initialize project
knowns init

# Create documentation
knowns doc create "Auth Pattern" -d "JWT authentication" -t "patterns" -f patterns

# Create task with context
knowns task create "Add authentication" \
  -d "Implement JWT auth following @doc/patterns/auth-pattern" \
  --ac "User can login" \
  --ac "Session persists"

# View task (AI-readable)
knowns task view 1 --plain

# Open Web UI
knowns browser
```

## Commands

### Tasks

```bash
knowns task create "Title" -d "Description" --ac "Criterion"
knowns task view <id> --plain
knowns task list --plain
knowns task edit <id> -s in-progress -a @me
knowns task edit <id> --check-ac 1 --check-ac 2
knowns task edit <id> --plan "1. Step 1\n2. Step 2"
knowns task edit <id> --notes "Implementation summary"
```

### Documentation

```bash
knowns doc create "Title" -d "Description" -t "tags" -f "folder"
knowns doc view "doc-name" --plain
knowns doc list --plain
knowns doc edit "doc-name" -c "New content"
knowns doc edit "doc-name" -a "Appended content"
```

### Time Tracking

```bash
knowns time start <task-id>
knowns time stop
knowns time status
knowns time report --from "2025-01-01" --to "2025-12-31"
```

### Search

```bash
knowns search "query" --plain
knowns search "auth" --type task --plain
knowns search "patterns" --type doc --plain
```

### Other

```bash
knowns browser              # Open Web UI
knowns agents --update-instructions  # Sync AI guidelines
knowns mcp                  # Start MCP server
```

## Reference System

Link tasks and docs using `@` syntax:

| Type | Input | Output |
|------|-------|--------|
| Task | `@task-42` | `@.knowns/tasks/task-42 - Title.md` |
| Doc | `@doc/patterns/auth` | `@.knowns/docs/patterns/auth.md` |

**Example:**
```markdown
Implement auth following @doc/patterns/guards
Related: @task-42 @task-38
```

AI reads task → sees refs → fetches context → implements correctly.

## Web UI

```bash
knowns browser
```

Features:
- **Kanban Board** - Drag & drop tasks
- **Document Browser** - Tree view with markdown preview
- **Task Details** - Inline editing with acceptance criteria
- **Dark Mode** - System preference aware
- **Global Search** - Cmd+K

## MCP Server (Claude Desktop)

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

Claude can now read your tasks and documentation automatically.

## Project Structure

```
.knowns/
├── tasks/              # Task markdown files
├── docs/               # Documentation
│   ├── patterns/
│   ├── guides/
│   └── architecture/
└── config.json         # Project config
```

## Task Workflow

```bash
# 1. Take task
knowns task edit <id> -s in-progress -a @me

# 2. Start timer
knowns time start <id>

# 3. Create plan
knowns task edit <id> --plan "1. Research\n2. Implement\n3. Test"

# 4. Work & check criteria
knowns task edit <id> --check-ac 1 --check-ac 2

# 5. Add notes
knowns task edit <id> --notes "Implementation complete"

# 6. Stop timer & complete
knowns time stop
knowns task edit <id> -s done
```

## Development

```bash
bun install
bun run dev      # Dev mode
bun run build    # Build
bun run lint     # Lint
```

## Links

- [npm](https://www.npmjs.com/package/knowns)
- [GitHub](https://github.com/knowns-dev/knowns)
- [Changelog](./CHANGELOG.md)

---

<p align="center">
  <strong>Know what your team knows.</strong><br>
  Built for dev teams who pair with AI.
</p>
