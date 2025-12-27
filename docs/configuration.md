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

The `.knowns/` folder is designed to be committed to git:

```bash
git add .knowns/
git commit -m "Add project knowledge base"
```

### .gitignore

You may want to ignore certain files:

```gitignore
# Ignore time tracking state (optional)
.knowns/.timer
```

## AI Agent Guidelines

Knowns can sync guidelines to AI assistants:

```bash
knowns agents --update-instructions
```

This updates:
- `CLAUDE.md` - For Claude Code
- `.github/copilot-instructions.md` - For GitHub Copilot
- Other AI-specific config files

## Environment Variables

| Variable | Description |
|----------|-------------|
| `KNOWNS_PORT` | Default port for `knowns browser` |

## Defaults

| Setting | Default |
|---------|---------|
| Web UI port | 3456 |
| Task priority | medium |
| Task status | todo |
