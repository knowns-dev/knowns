# Configuration

Customize Knowns behavior with configuration options.

## Project Configuration

Located at `.knowns/config.json`:

```json
{
  "project": "my-project",
  "version": "1.0.0"
}
```

### Options

| Key | Type | Description |
|-----|------|-------------|
| `project` | string | Project name |
| `version` | string | Config version |
| `defaultAssignee` | string | Default assignee for new tasks |
| `defaultPriority` | string | Default priority (`low`, `medium`, `high`) |
| `defaultLabels` | string[] | Default labels for new tasks |
| `timeFormat` | string | Time format (`12h` or `24h`) |
| `gitTrackingMode` | string | Git tracking mode (`git-tracked` or `git-ignored`) |
| `settings.semanticSearch` | object | Semantic search configuration (see below) |

### Semantic Search Settings

The `settings.semanticSearch` object configures the embedding model for semantic search:

```json
{
  "settings": {
    "semanticSearch": {
      "enabled": true,
      "model": "gte-small",
      "huggingFaceId": "Xenova/gte-small",
      "dimensions": 384,
      "maxTokens": 512
    }
  }
}
```

| Key | Type | Description |
|-----|------|-------------|
| `enabled` | boolean | Enable/disable semantic search |
| `model` | string | Model ID (e.g., `gte-small`, `gte-base`) |
| `huggingFaceId` | string | Full HuggingFace model ID (optional, for custom models) |
| `dimensions` | number | Embedding vector dimensions (optional) |
| `maxTokens` | number | Max input tokens (optional) |

**Managing models via CLI:**

```bash
# List available models
knowns model list

# Download and set a model
knowns model download gte-base
knowns model set gte-base

# Add custom HuggingFace model
knowns model add Xenova/bge-large-en-v1.5 --dims 1024

# Rebuild search index after changing model
knowns search --reindex
```

**Model storage:**

Models are stored globally at `~/.knowns/models/` and shared across all projects.

Custom models are tracked in `~/.knowns/custom-models.json`.

## Project Structure

After `knowns init`, your project contains:

```
.knowns/
├── config.json       # Project configuration
├── tasks/            # Task markdown files
│   ├── task-1 - First Task.md
│   └── task-2 - Second Task.md
└── docs/             # Documentation
    ├── ai/           # AI integration
    ├── architecture/ # Technical patterns
    ├── core/         # Core concepts
    ├── development/  # For contributors
    ├── guides/       # User guides
    └── templates/    # Template system
```

### Task Files

Each task is a markdown file with frontmatter:

```markdown
---
id: "42"
title: "Add authentication"
status: "in-progress"
priority: "high"
assignee: "@john"
labels: ["feature", "auth"]
createdAt: "2025-01-15T10:00:00Z"
updatedAt: "2025-01-15T14:30:00Z"
---

## Description

Implement JWT authentication...

## Acceptance Criteria

- [x] User can login
- [ ] JWT token returned

## Implementation Plan

1. Research patterns
2. Implement

## Implementation Notes

Completed login endpoint.
```

### Document Files

Each document is a markdown file with frontmatter:

```markdown
---
title: "Auth Pattern"
description: "JWT authentication pattern"
tags: ["patterns", "security"]
createdAt: "2025-01-10T09:00:00Z"
updatedAt: "2025-01-12T16:00:00Z"
---

# Auth Pattern

This document describes our authentication pattern...
```

## Init Wizard

When running `knowns init`, an interactive wizard guides you through setup:

```
🚀 Knowns Project Setup Wizard
   Configure your project settings

? Project name: my-project
? Git tracking mode: Git Tracked (recommended for teams)
? AI Guidelines type: CLI
? Select AI agent files to create/update:
  ◉ CLAUDE.md (Claude Code)
  ◉ AGENTS.md (Agent SDK)
```

| Option | Description |
|--------|-------------|
| **Project name** | Name stored in config.json |
| **Git tracking mode** | `git-tracked` (default) or `git-ignored` |
| **AI Guidelines type** | `CLI` (commands) or `MCP` (tools) |
| **Agent files** | Which instruction files to create |

**When MCP is selected:**
- Creates `.mcp.json` for Claude Code auto-discovery

**Skip wizard:**
```bash
knowns init my-project --no-wizard  # Use defaults
```

## Git Integration

Knowns supports two git tracking modes, selected during `knowns init`:

### Git Tracking Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| `git-tracked` | All `.knowns/` files tracked in git | Teams, shared context |
| `git-ignored` | Only docs/templates tracked, tasks/config ignored | Personal use |

### Git-Tracked Mode (Default)

The entire `.knowns/` folder is committed to git:

```bash
git add .knowns/
git commit -m "Add project knowledge base"
```

**Benefits:**
- Share tasks and docs with team
- Version history for all changes
- Code review includes task updates

### Git-Ignored Mode

Only documentation and templates are tracked. During init, Knowns automatically adds to `.gitignore`:

```gitignore
# knowns (ignore all except docs and templates)
.knowns/*
!.knowns/docs/
!.knowns/docs/**
!.knowns/templates/
!.knowns/templates/**
```

**Benefits:**
- Personal task tracking without cluttering team repo
- Docs and templates still shareable with team
- No merge conflicts on tasks

### .gitignore (Optional)

You may want to ignore certain files regardless of mode:

```gitignore
# Ignore time tracking state (optional)
.knowns/.timer
```

## Configuration Commands

Manage project configuration via CLI:

```bash
# Get a config value
knowns config get defaultAssignee --plain

# Set a config value
knowns config set defaultAssignee "@john"

# List all config
knowns config list
```

## AI Agent Guidelines

Knowns provides instruction file sync and on-demand guidelines via MCP:

```bash
# Quick sync with full embedded guidelines (~26KB)
knowns sync

# Sync with minimal instruction only (~1KB)
knowns sync --minimal

# Sync all files with MCP guidelines
knowns sync --type mcp --all

# Use unified guidelines (CLI + MCP)
knowns sync --type unified
```

**Supported files:**
- `CLAUDE.md` - For Claude Code (default)
- `AGENTS.md` - For Agent SDK (default)
- `GEMINI.md` - For Google Gemini
- `.github/copilot-instructions.md` - For GitHub Copilot

## Environment Variables

| Variable | Description |
|----------|-------------|
| `KNOWNS_PORT` | Default port for `knowns browser` |

## Defaults

| Setting | Default |
|---------|---------|
| Web UI port | 6420 |
| Task priority | medium |
| Task status | todo |
