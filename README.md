<p align="center">
  <img src="images/cover.png" alt="Knowns — The Memory Layer for AI-Native Development" width="100%">
</p>

# Knowns

[![npm](https://img.shields.io/npm/v/knowns.svg?style=flat-square)](https://www.npmjs.com/package/knowns)
[![GitHub stars](https://img.shields.io/github/stars/knowns-dev/knowns?style=flat-square)](#)
[![Contributors](https://img.shields.io/github/contributors/knowns-dev/knowns?style=flat-square)](#)
[![Last Commit](https://img.shields.io/github/last-commit/knowns-dev/knowns?style=flat-square)](#)
[![License](https://img.shields.io/github/license/knowns-dev/knowns?style=flat-square)](#)

> Turn stateless AI into a project-aware engineering partner.

**Knowns is the memory layer for AI-native software development — enabling AI to understand your project instantly.**

Instead of starting from zero every session, AI works with structured, persistent project context.

No repeated explanations.  
No pasted docs.  
No lost architectural knowledge.

Just AI that already understands your system.

⭐ If you believe AI should truly understand software projects, consider giving **Knowns** a star.

## Table of Contents

- [Why Knowns?](#why-knowns)
- [What is Knowns?](#what-is-knowns---really)
- [Core Capabilities](#core-capabilities)
- [How It Works](#how-it-works)
- [Installation](#installation)
- [What You Can Build](#what-you-can-build-with-knowns)
- [Quick Reference](#quick-reference)
- [Claude Code Skills Workflow](#claude-code-skills-workflow)
- [Documentation](#documentation)
- [Roadmap](#roadmap)
- [Development](#development)
- [Links](#links)

---

## Why Knowns?

AI is powerful — but fundamentally **stateless**.

Every session forces developers to:

- Re-explain architecture  
- Paste documentation  
- Repeat conventions  
- Clarify past decisions  
- Rebuild context  

This breaks flow and limits AI’s effectiveness.

### AI doesn't lack intelligence.

### It lacks the right context.

**Knowns fixes that.**

---

## What is Knowns - Really?

Knowns provides **persistent, structured project understanding** so AI can operate with full awareness of your software environment.

Think of it as your project's **external brain**.

Knowns connects:

- Specs  
- Tasks  
- Documentation  
- Decisions  
- Team knowledge  

So AI doesn’t just generate code — it understands what it’s building.

---

## Core Capabilities

### 🧠 Persistent Project Memory
Give AI long-term understanding of your codebase and workflows.

### 🔗 Structured Knowledge
Connect specs, tasks, and docs into a unified context layer.

### ⚡ Smart Context Delivery
Automatically provide relevant context to AI — reducing noise and token usage.

### 🤝 AI-Native Workflow
Transform AI from a tool into a true engineering collaborator.

### 🔐 Self-Hostable
Keep your knowledge private and fully under your control.

---

## How It Works

Knowns sits **above your existing tools** and makes them readable by AI.

Your stack stays the same.

But now:

- Specs → understood  
- Tasks → connected  
- Docs → usable  
- Decisions → remembered  

AI stops guessing — and starts contributing.

---

## Installation

```bash
# Homebrew (macOS/Linux) - no Node.js required
brew install knowns-dev/tap/knowns

# npm
npm install -g knowns

# bun
bun install -g knowns

# npx (no install)
npx knowns


knowns init
knowns browser  # Open Web UI
```

---

## What You Can Build With Knowns

| Feature              | Description                                        |
| -------------------- | -------------------------------------------------- |
| **Task Management**  | Create, track tasks with acceptance criteria       |
| **Documentation**    | Nested folders with markdown + mermaid support     |
| **Time Tracking**    | Built-in timers and reports                        |
| **Context Linking**  | `@task-42` and `@doc/patterns/auth` references     |
| **Validation**       | Check broken refs with `knowns validate`           |
| **Template System**  | Code generation with Handlebars (`.hbs`) templates |
| **Import System**    | Import docs/templates from git, npm, or local      |
| **AI Integration**   | Full MCP Server with AC/plan/notes operations      |
| **Web UI**           | Kanban board, doc browser, mermaid diagrams        |

---

## Quick Reference

```bash
# Tasks
knowns task create "Title" -d "Description" --ac "Criterion"
knowns task list --plain
knowns task <id> --plain                    # View task (shorthand)
knowns task edit <id> -s in-progress -a @me
knowns task edit <id> --check-ac 1          # Mark AC as done

# Documentation
knowns doc create "Title" -d "Description" -f "folder"
knowns doc "doc-name" --plain               # View doc (shorthand)
knowns doc "doc-name" --smart --plain       # Auto-handle small/large docs
knowns doc "doc-name" --section "2" --plain # Read specific section

# Templates
knowns template list                        # List available templates
knowns template run <name> --name "X"       # Generate from template
knowns template create <name>               # Create new template

# Imports
knowns import add <name> <source>           # Add import
knowns import sync                          # Sync all imports
knowns import list                          # List imports

# Time, Search & Validate
knowns time start <id> && knowns time stop
knowns search "query" --plain
knowns validate                             # Check broken refs

# AI Guidelines
knowns agents sync                          # Sync CLAUDE.md, AGENTS.md
knowns agents sync --type mcp               # MCP tools format
```

---

## Claude Code Skills Workflow

When using Claude Code with Knowns, use skills (slash commands) for a guided workflow:

```
/kn-init     → Read project docs, understand context
/kn-plan     → Take task, gather context, create plan (wait for approval)
/kn-implement → Follow plan, check ACs, track progress
/kn-commit   → Commit with conventional format
```

### Example Session

```
You: /kn-init
Claude: [Reads README, ARCHITECTURE, checks task backlog]
        "Project uses NestJS with CQRS pattern. 3 tasks in-progress..."

You: /kn-plan 42
Claude: [Takes task, reads refs, searches docs]
        "Task #42: Add user authentication

         ## Implementation Plan
         1. Review @doc/patterns/auth
         2. Create AuthModule with JWT strategy
         3. Add login/register endpoints
         4. Write unit tests

         Approve this plan?"

You: Yes

You: /kn-implement 42
Claude: [Follows plan, generates code, checks ACs]
        "✓ AC1: User can login - DONE
         ✓ AC2: JWT token returned - DONE
         ✓ AC3: Tests pass - DONE

         All acceptance criteria complete. Ready to commit?"

You: /kn-commit
Claude: [Creates conventional commit]
        "feat(auth): add JWT authentication

         - Add AuthModule with passport JWT strategy
         - Add login/register endpoints
         - Add unit tests (94% coverage)"
```

### All Skills

| Skill | Description |
|-------|-------------|
| `/kn-init` | Initialize session - read docs, understand project |
| `/kn-plan <id>` | Take task, gather context, create implementation plan |
| `/kn-implement <id>` | Execute plan, track progress, check acceptance criteria |
| `/kn-research` | Search codebase, find patterns, explore before coding |
| `/kn-commit` | Create conventional commit with verification |
| `/kn-doc` | Create or update documentation |
| `/kn-extract` | Extract reusable patterns into docs/templates |
| `/kn-template` | List, run, or create code templates |

---

## Documentation

| Guide                                          | Description                                |
| ---------------------------------------------- | ------------------------------------------ |
| [Command Reference](./docs/commands.md)        | All CLI commands with examples             |
| [Workflow Guide](./docs/workflow.md)           | Task lifecycle from creation to completion |
| [Reference System](./docs/reference-system.md) | How `@doc/` and `@task-` linking works     |
| [Templates](./docs/templates.md)               | Code generation with Handlebars            |
| [Web UI](./docs/web-ui.md)                     | Kanban board and document browser          |
| [MCP Integration](./docs/mcp-integration.md)   | Claude Desktop setup with full MCP tools   |
| [Configuration](./docs/configuration.md)       | Project structure and options              |
| [Developer Guide](./docs/developer-guide.md)   | Technical docs for contributors            |
| [Changelog](./CHANGELOG.md)                    | Version history                            |

---

## Roadmap

### Self-Hosted Team Sync 🚧 (Planned)

Knowns will optionally support a self-hosted sync server — for teams that want shared visibility without giving up local-first workflows.

- **Real-time visibility** — See who is working on what
- **Shared knowledge** — Sync tasks and documentation across the team
- **Progress tracking** — Track activity over time
- **Full data control** — Self-hosted, no cloud dependency

The CLI and local `.knowns/` folder remain the source of truth.
The server acts only as a sync and visibility layer.

---

## Development

```bash
npm install
npm run dev      # Dev mode
npm run build    # Build
npm run test     # Test
```

## Links

- [npm](https://www.npmjs.com/package/knowns)
- [GitHub](https://github.com/knowns-dev/knowns)
- [Discord](https://discord.knowns.dev)
- [Changelog](./CHANGELOG.md)

For design principles and long-term direction, see [Philosophy](./PHILOSOPHY.md).

For technical details, see [Architecture](./ARCHITECTURE.md) and [Contributing](./CONTRIBUTING.md).

---

<p align="center">
  <strong>What your AI should have knowns.</strong><br>
  Built for dev teams who pair with AI.
</p>
