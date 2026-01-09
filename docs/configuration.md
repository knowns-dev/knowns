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

## Project Structure

After `knowns init`, your project contains:

```
.knowns/
├── config.json       # Project configuration
├── tasks/            # Task markdown files
│   ├── task-1 - First Task.md
│   └── task-2 - Second Task.md
└── docs/             # Documentation
    ├── patterns/
    ├── architecture/
    └── guides/
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

## Git Integration

Knowns supports two git tracking modes, selected during `knowns init`:

### Git Tracking Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| `git-tracked` | All `.knowns/` files tracked in git | Teams, shared context |
| `git-ignored` | Only docs tracked, tasks/config ignored | Personal use |

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

Only documentation is tracked. During init, Knowns automatically adds to `.gitignore`:

```gitignore
# knowns (ignore all except docs)
.knowns/*
!.knowns/docs/
!.knowns/docs/**
```

**Benefits:**
- Personal task tracking without cluttering team repo
- Docs still shareable with team
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

Knowns provides on-demand guidelines and instruction file sync:

```bash
# Output guidelines to stdout (AI agents call this at session start)
knowns agents guideline

# Interactive mode - select type, variant, and files
knowns agents

# Quick sync with minimal instruction (~600 bytes)
knowns agents sync

# Sync with full embedded guidelines (~4KB)
knowns agents sync --full

# Sync all files with MCP guidelines
knowns agents sync --type mcp --all
```

**Supported files:**
- `CLAUDE.md` - For Claude Code (default)
- `AGENTS.md` - For Agent SDK (default)
- `GEMINI.md` - For Google Gemini
- `.github/copilot-instructions.md` - For GitHub Copilot

**Template variants:**
- `instruction` (default): Minimal - tells AI to call `knowns agents guideline`
- `general` (`--full`): Full guidelines embedded in file

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
