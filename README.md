# Knowns

> **Know what your team knows.**

CLI tool for dev teams to manage tasks and documentation with AI-first context linking.

[![npm version](https://img.shields.io/npm/v/knowns.svg?style=flat-square)](https://www.npmjs.com/package/knowns)
[![npm downloads](https://img.shields.io/npm/dm/knowns.svg?style=flat-square)](https://www.npmjs.com/package/knowns)
[![CI](https://img.shields.io/github/actions/workflow/status/knowns-dev/knowns/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/knowns-dev/knowns/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](./LICENSE)
[![Bundle Size](https://img.shields.io/bundlephobia/min/knowns?style=flat-square)](https://bundlephobia.com/package/knowns)

## Why Knowns?

**Problem:** AI assistants lose context between sessions. You repeat the same architecture explanations, patterns, and decisions over and over.

**Solution:** Knowns links tasks to documentation with structured context that AI can understand and reference automatically.

## Core Features

### 1. **Context-Aware Task Management**
- Link documentation directly in task descriptions
- AI sees `@.knowns/docs/patterns/guards.md` and knows where to find context
- Related Documentation section auto-extracts all doc links
- No more "remind me how authentication works again"

### 2. **Time Tracking Built-In**
- Start/stop timers per task
- Track total time spent
- View time history with task context
- Perfect for time reporting and productivity analysis

### 3. **Smart Documentation**
- Nested folder structure (`patterns/`, `guides/`, `architecture/`)
- Markdown links automatically resolve to `@.knowns/docs/` paths
- Search across all docs instantly
- AI can fetch exact context when needed

### 4. **AI Integration**
- `--plain` flag outputs clean text for AI consumption
- MCP Server for Claude Desktop integration
- Agent instructions sync across Claude, Gemini, Copilot
- Every task and doc is AI-readable

## Who Should Use Knowns?

### Perfect For:

1. **Teams using AI assistants** - Stop repeating context every session
2. **Projects with established patterns** - Document once, link everywhere
3. **Remote/async teams** - Knowledge doesn't live in someone's head
4. **Developers who pair with AI** - Give AI perfect project memory
5. **Teams tracking time** - Context + time in one place

### Not For:

- Large enterprises needing complex permissions (use Jira)
- Non-technical teams (no markdown)
- Projects without established patterns yet

## Installation

```bash
# Using npm
npm install -g knowns

# Or using bun
bun install -g knowns
```

## Quick Start

```bash
# 1. Initialize in your project (interactive wizard)
knowns init

# Or with project name directly
knowns init "My Project"

# 2. Create documentation for your patterns
knowns doc create "Authentication Pattern" \
  -d "JWT-based auth with guards" \
  -t "patterns,auth"

# 3. Create task with context links
knowns task create "Add user authentication" \
  -d $'Implement JWT auth following [authentication pattern](./patterns/authentication-pattern.md)

Requirements:
- Use JWT tokens
- Email/password login
- Session persistence' \
  --ac "User can login with email/password" \
  --ac "Session persists across page refresh"

# 4. View task (AI-readable format)
knowns task view 1 --plain

# Output shows:
# Description: ...
# Related Documentation:
# 📄 authentication pattern: @.knowns/docs/patterns/authentication-pattern.md

# 5. AI reads the linked docs and implements with full context!
```

**Key insight:** Link docs in descriptions. AI gets context automatically.

## The Context Problem

### Before Knowns:

```
Session 1:
You: "Implement feature X"
AI: "How does your auth work?"
You: *explains guards pattern*
AI: *implements*

Session 2 (next day):
You: "Implement feature Y"
AI: "How does your auth work?"
You: *explains AGAIN*
```

### With Knowns:

```
Session 1:
You: "Implement feature X, follow [guards.md](./patterns/guards.md)"
AI: *reads doc, implements correctly*

Session 2:
You: "Implement feature Y, follow [guards.md](./patterns/guards.md)"
AI: *reads same doc, implements consistently*

Session 100:
You: "Implement feature Z, follow [guards.md](./patterns/guards.md)"
AI: *still reads same doc, never forgets*
```

**Benefits:**
- ✅ No repetition
- ✅ Consistent implementations
- ✅ Onboarding is instant (AI reads docs)
- ✅ Documentation stays up-to-date (it's actually used)
- ✅ New team members follow same patterns

## Commands

### Task Management

```bash
# Create task
knowns task create "Title" -d "Description" --ac "Criterion 1"

# View task
knowns task view <id> --plain

# Edit task
knowns task edit <id> -s "In Progress" -a @yourself
knowns task edit <id> --check-ac 1
knowns task edit <id> --plan $'1. Research\n2. Implement\n3. Test'
knowns task edit <id> --notes "Implementation complete"

# List tasks
knowns task list --plain
knowns task list -s "In Progress" --plain
```

### Documentation

```bash
# List all docs (includes nested folders)
knowns doc list --plain

# View document
knowns doc view patterns/guards --plain

# Create document
knowns doc create "API Guidelines" -d "REST API standards" -t "api,backend"

# Edit metadata
knowns doc edit <name> -t "New Title" -d "Updated description"
```

### Search

```bash
# Search everything
knowns search "authentication" --plain

# Search tasks only
knowns search "login" --type task --plain

# Search with filters
knowns search "api" --status "In Progress" --plain
```

### Web UI

```bash
# Open browser UI (Kanban + Docs)
knowns browser

# Open on specific port
knowns browser -p 8080
```

### Project Initialization

```bash
# Interactive wizard (recommended)
knowns init

# 🚀 Knowns Project Setup Wizard
# ? Project name › my-project
# ? Default assignee (optional) › @claude
# ? Default priority for new tasks › Medium
# ? Default labels (comma-separated) › frontend, ui
# ? Time format › 24-hour

# Quick init with name
knowns init "My Project"

# Skip wizard, use defaults
knowns init --no-wizard
```

### Agent Instructions

```bash
# Sync guidelines to all agent instruction files
knowns agents --update-instructions
```

Updates:
- `CLAUDE.md` - Claude Code
- `AGENTS.md` - Agent SDK
- `GEMINI.md` - Gemini
- `.github/copilot-instructions.md` - GitHub Copilot

## Task Workflow

### 1. Take Task
```bash
knowns task edit <id> -s "In Progress" -a @yourself
```

### 2. Create Plan
```bash
knowns task edit <id> --plan $'1. Research API\n2. Implement feature\n3. Add tests'
```

### 3. Work & Check Criteria
```bash
# As you complete acceptance criteria
knowns task edit <id> --check-ac 1 --check-ac 2 --check-ac 3
```

### 4. Add Implementation Notes
```bash
knowns task edit <id> --notes $'Implemented using X pattern\nAdded comprehensive tests\nReady for review'
```

### 5. Complete
```bash
knowns task edit <id> -s Done
```

## File Structure

After `knowns init`:

```
.knowns/
├── tasks/              # Task markdown files
└── docs/               # Documentation (supports nested folders)
    ├── patterns/
    ├── guides/
    └── architecture/
```

## Context Linking in Action

### Problem: AI Loses Context

**Without Knowns:**
```
User: "Implement authentication for the new API endpoint"
AI: "Sure! What authentication method are you using?"
User: "We use JWT with guards pattern"
AI: "Can you explain your guards pattern?"
User: *explains again for the 10th time*
```

**With Knowns:**
```bash
# Create task with context links
knowns task create "Implement auth for /users endpoint" \
  -d "Follow our standard [guards pattern](./patterns/guards.md) and [JWT setup](./patterns/authentication.md)"

# AI reads task
knowns task view 42 --plain
```

**Output:**
```
Description:
Follow our standard guards pattern and JWT setup

Related Documentation:
📄 guards pattern: @.knowns/docs/patterns/guards.md
📄 JWT setup: @.knowns/docs/patterns/authentication.md
```

AI now knows EXACTLY where to find your patterns. No context loss.

### How It Works

1. **Link docs in task descriptions:**
   ```markdown
   See [mapper pattern](./patterns/mapper.md) for data conversion
   ```

2. **AI-readable output:**
   ```bash
   knowns task view 1 --plain
   # Shows: @.knowns/docs/patterns/mapper.md
   ```

3. **AI fetches context automatically:**
   - Via MCP Server (Claude Desktop)
   - Via search commands
   - Direct doc reading

### Example: Complete Task with Context

```bash
knowns task create "Add user profile endpoint" -d $'Implement GET /api/users/:id

Architecture:
- Follow [controller pattern](./patterns/controller.md)
- Use [repository pattern](./patterns/repository.md) for data access
- Apply [DTO pattern](./patterns/dto.md) for response
- Add [guards](./patterns/guards.md) for auth

See [API guidelines](./guides/api-standards.md) for naming conventions'
```

When AI reads this task, it sees:
```
Related Documentation:
📄 controller pattern: @.knowns/docs/patterns/controller.md
📄 repository pattern: @.knowns/docs/patterns/repository.md
📄 DTO pattern: @.knowns/docs/patterns/dto.md
📄 guards: @.knowns/docs/patterns/guards.md
📄 API guidelines: @.knowns/docs/guides/api-standards.md
```

AI has ALL the context it needs. Zero repetition.

## Features Deep Dive

### Smart Document Linking

Links in tasks/docs are automatically resolved:

**Markdown:**
```markdown
[guards.md](./patterns/guards.md)
```

**Plain output:**
```
@.knowns/docs/patterns/guards.md
```

### Acceptance Criteria Management

```bash
# Add criteria
knowns task edit 42 --ac "New criterion"

# Check multiple at once
knowns task edit 42 --check-ac 1 --check-ac 2 --check-ac 3

# Uncheck
knowns task edit 42 --uncheck-ac 2

# Remove
knowns task edit 42 --remove-ac 3
```

### Multi-line Input

**Bash/Zsh:**
```bash
knowns task edit 42 --plan $'1. Step one\n2. Step two\n3. Step three'
```

**PowerShell:**
```powershell
knowns task edit 42 --notes "Line 1`nLine 2"
```

### Time Tracking

```bash
# Start timer for task
knowns time start 42

# Stop timer
knowns time stop 42

# View time spent
knowns task view 42 --plain
# Shows: Time Spent: 2h 30m

# View time history
knowns time list 42
```

**Why built-in time tracking?**
- Task context is preserved (what you worked on)
- Links to documentation show what you learned
- AI can analyze time patterns
- No separate time tracking tool needed

### Search with Filters

```bash
# By status
knowns search "api" --status "In Progress"

# By priority
knowns search "bug" --priority high

# By assignee
knowns task list -a @john --plain
```

## Web UI

The browser UI provides:

- **Kanban Board** - Drag & drop tasks across status columns
- **Task Details** - Full task view with inline editing
- **Document Browser** - Tree view with markdown preview
- **Configuration** - Full config.json editing (Form + JSON modes)
- **Dark Mode** - System preference aware
- **Search** - Global search across tasks and docs (Cmd+K)
- **Time Tracking** - Start/stop timers, view history

### Configuration Page

Edit all project settings through the Web UI:

- **Project Name** - Change project display name
- **Default Assignee** - Set default for new tasks
- **Default Priority** - Low, Medium, High
- **Default Labels** - Comma-separated labels
- **Task Statuses** - Add/remove custom statuses with colors
- **Visible Columns** - Configure Kanban board columns
- **JSON Mode** - Direct config.json editing for advanced users

## MCP Server - AI Context Integration

Knowns includes a Model Context Protocol server that lets AI (Claude Desktop) access your context automatically.

### Setup

Add to Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

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

### What It Does

When you tell Claude: *"Implement the user profile feature"*

Claude can now:
1. **Read task**: `knowns task view 42 --plain`
2. **See linked docs**: `@.knowns/docs/patterns/controller.md`
3. **Fetch context**: Reads controller pattern automatically
4. **Implement correctly**: Following your exact patterns

**No more:**
- "Can you explain your architecture?"
- "What's your naming convention?"
- "How do you structure controllers?"

**AI already knows** because it reads your docs.

### Available Tools

The MCP server provides:
- `search_tasks` - Find relevant tasks
- `read_task` - Get full task with linked docs
- `search_docs` - Find documentation
- `read_doc` - Get doc content
- `list_docs` - Browse doc structure

### Example Conversation

```
You: "Start working on task 42"

Claude: [Reads task via MCP]
"I see this task requires implementing auth following the guards
pattern. Let me check the guards documentation..."
[Fetches @.knowns/docs/patterns/guards.md via MCP]
"Got it! I'll implement JWT guard with email verification check
as documented. Starting implementation..."
```

**Zero context loss. AI has perfect memory of your project.**

## Development

```bash
# Install dependencies
bun install

# Run in dev mode
bun run dev

# Build
bun run build

# Lint
bun run lint

# Format
bun run format
```

## Guidelines

**Core Principle:** Never edit `.md` files directly. Always use CLI commands.

```bash
# ❌ Wrong
vim .knowns/tasks/task-42.md

# ✅ Right
knowns task edit 42 -d "Updated description"
```

See [CLAUDE.md](./CLAUDE.md) for complete guidelines.

## Contributing

Contributions welcome! Please read our contributing guidelines before submitting PRs.

## License

MIT © [Knowns Contributors](./LICENSE)

## Links

- [npm package](https://www.npmjs.com/package/knowns)
- [GitHub repository](https://github.com/knowns-dev/knowns)
- [Issues](https://github.com/knowns-dev/knowns/issues)
- [Changelog](https://github.com/knowns-dev/knowns/releases)

---

**Know what your team knows.**

Built for dev teams who pair with AI and value structured knowledge over tribal knowledge.
