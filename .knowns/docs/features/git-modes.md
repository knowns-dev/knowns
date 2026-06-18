---
title: Git Tracking Modes
description: Documentation for git-tracked vs git-ignored modes
createdAt: '2026-01-05T16:59:24.389Z'
updatedAt: '2026-06-18T15:38:39.302Z'
tags:
  - feature
  - git
---

## Overview

Knowns supports two git tracking modes, selected during project initialization with `knowns init`. Granular per-section toggles allow fine-grained control over which entity types are tracked.

## Modes

### git-tracked (Default)

**Use Case:** Teams, shared project context

All durable `.knowns/` knowledge files are tracked in git by default:
- Tasks, docs, templates, decisions, and config shared with the team
- Full version history for changes
- Code review can include task and decision updates

Runtime/cache files such as `.search/`, runtime state, worktrees, and server port files remain ignored.

```bash
# After init, commit the project knowledge base
git add .knowns/
git commit -m "Add project knowledge base"
```

### git-ignored

**Use Case:** Personal use, individual tracking

Only selected sections are tracked. Knowns auto-updates `.knowns/.gitignore` based on your per-section settings.

By default, `git-ignored` tracks config plus the team-shareable knowledge sections: docs, templates, tasks, and decisions. Memories remain off by default because they are usually agent-specific.

```gitignore
# Managed by Knowns CLI — do not edit manually.
# Run 'knowns init' to regenerate.

# Ignore everything by default
*

# Track these
!.gitignore
!config.json
!docs/
!docs/**
!templates/
!templates/**
!tasks/
!tasks/**
!decisions/
!decisions/**
```

**Benefits:**
- Personal memory entries can stay local
- Docs, templates, tasks, and decisions remain shareable with the team
- Teams can review durable project decisions alongside code changes

## Granular Per-Section Toggles

Knowns supports per-section git tracking via `settings.gitTracking` in `.knowns/config.json`:

```json
{
  "settings": {
    "gitTracking": {
      "tasks": true,
      "docs": true,
      "templates": true,
      "decisions": true,
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
| `decisions` | true | true | Decision records |
| `memories` | false | false | AI memory entries, usually personal |

These toggles control which `.knowns/` subdirectories are included or excluded in `.knowns/.gitignore`. Memories default to `false` in all modes because memory entries are typically agent-specific; decisions default to `true` because they are durable project guidance.

## Switching Modes

To switch modes after initialization:

1. Edit `.knowns/config.json` and change `settings.gitTrackingMode`.
2. Optionally adjust `settings.gitTracking` section toggles.
3. Run `knowns sync` to regenerate `.knowns/.gitignore` from config.

You can also use `knowns init --force` to rerun initialization with existing config as defaults.

## Related

- @doc/guides/user-guide - Getting started
- @doc/architecture/patterns/storage - File storage details
- @doc/features/init-process - Init wizard flow
- @doc/features/sync-command - Applying config after clone or update
