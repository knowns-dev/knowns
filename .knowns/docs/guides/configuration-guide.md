---
title: Configuration Guide
createdAt: '2026-02-24T08:44:33.245Z'
updatedAt: '2026-02-24T08:44:33.245Z'
description: Project configuration options and settings
tags:
  - guide
  - config
  - settings
---
# Configuration Guide

Customize Knowns behavior. Full docs: `./docs/configuration.md`

## Config File

Located at `.knowns/config.json`:

```json
{
  "project": "my-project",
  "version": "1.0.0",
  "defaultAssignee": "@me",
  "defaultPriority": "medium",
  "defaultLabels": [],
  "settings": {
    "semanticSearch": {
      "enabled": true,
      "model": "gte-small"
    }
  }
}
```

## Options

| Key | Type | Description |
|-----|------|-------------|
| `project` | string | Project name |
| `defaultAssignee` | string | Default assignee for new tasks |
| `defaultPriority` | string | `low`, `medium`, `high` |
| `defaultLabels` | string[] | Default labels |
| `gitTrackingMode` | string | `git-tracked` or `git-ignored` |

## Semantic Search Settings

| Key | Type | Description |
|-----|------|-------------|
| `enabled` | boolean | Enable semantic search |
| `model` | string | Model ID (e.g., `gte-small`) |
| `huggingFaceId` | string | Custom HuggingFace model |
| `dimensions` | number | Embedding dimensions |

## CLI Config Commands

```bash
# Get value
knowns config get defaultAssignee --plain

# Set value
knowns config set defaultAssignee "@john"
knowns config set search.semantic.enabled true

# View all
knowns config list --plain
```

## Git Tracking Modes

| Mode | Description |
|------|-------------|
| `git-tracked` | Track .knowns/ in git (team sharing) |
| `git-ignored` | Ignore .knowns/ (local only) |

Set during `knowns init` or:
```bash
knowns config set gitTrackingMode git-tracked
```
