---
title: Git Tracking Modes
description: Documentation for git-tracked vs git-ignored modes
createdAt: '2026-01-05T16:59:24.389Z'
updatedAt: '2026-05-27T16:24:58.783Z'
tags:
  - feature
  - git
---

## Overview

Knowns supports two git tracking modes, selected during project initialization with `knowns init`. Additionally, granular per-section toggles allow fine-grained control over which entity types are tracked.

## Modes

### git-tracked (Default)

**Use Case:** Teams, shared project context

All `.knowns/` files are tracked in git:
- Tasks, docs, templates, and config shared with team
- Full version history for changes
- Code review can include task updates

```bash
# After init, commit everything
git add .knowns/
git commit -m "Add project knowledge base"
```

### git-ignored

**Use Case:** Personal use, individual tracking

Only selected sections are tracked. Knowns auto-updates `.gitignore` based on your per-section settings.

```gitignore
# knowns (ignore all except configured sections)
.knowns/*
!.knowns/docs/
!.knowns/docs/**
!.knowns/templates/
!.knowns/templates/**
```

**Benefits:**
- Personal task tracking without cluttering team repo
- Docs and templates still shareable with team
- No merge conflicts on task files

## Granular Per-Section Toggles

Since v0.22, Knowns supports per-section git tracking via `settings.gitTracking` in `.knowns/config.json`:

```json
{
  "settings": {
    "gitTracking": {
      "tasks": true,
      "docs": true,
      "templates": true,
      "memories": false
    }
  }
}
```

| Section | Default (git-tracked) | Default (git-ignored) | Description |
|---------|----------------------|----------------------|-------------|
| `tasks` | true | true | Task markdown files |
| `docs` | true | true | Documentation files |
| `templates` | true | true | Code generation templates |
| `memories` | false | false | AI memory entries (typically personal) |

These toggles control which `.knowns/` subdirectories are included or excluded in `.gitignore`. The `memories` section defaults to `false` in all modes since memory entries are typically agent-specific.

## Switching Modes

To switch modes after initialization:

1. Edit `.knowns/config.json` and change `gitTrackingMode`
2. Optionally adjust `gitTracking` section toggles
3. Run `knowns init --force` to regenerate `.gitignore` rules

Or manually update `.gitignore` accordingly.

## Related

- @doc/guides/user-guide - Getting started
- @doc/architecture/patterns/storage - File storage details
- @doc/features/init-process - Init wizard flow
