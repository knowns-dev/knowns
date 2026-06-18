---
title: Sync Command
description: knowns sync — apply config.json to set up skills, instructions, model, git, and search index
createdAt: '2026-03-27T07:10:42.070Z'
updatedAt: '2026-06-18T15:38:57.785Z'
tags: []
---

## Overview

`knowns sync` reads `.knowns/config.json` and applies project settings locally. This is the recommended command after cloning a repo that uses Knowns, or after editing config-driven settings such as git tracking.

## Use Case

```bash
git clone <repo>
knowns sync        # sets up everything from config.json
```

## What It Does

1. **Skills** — copies built-in skills to platform directories (`.claude/skills/`, `.agents/skills/`, `.kiro/skills/`; plus legacy `.agent/skills/` when an older project already uses it)
2. **Instructions** — generates agent instruction files (KNOWNS.md, CLAUDE.md, AGENTS.md, etc.) for configured platforms. Always overwrites to stay in sync with templates.
3. **Git integration** — applies `.knowns/.gitignore` rules based on `gitTrackingMode` and `gitTracking` section toggles
4. **Model download** — downloads the configured embedding model if not installed locally
5. **Import sync** — syncs git-based imports
6. **Search index** — rebuilds the semantic search index
7. **MCP configs** — syncs MCP config files to use the local binary

## Flags

| Flag | Description |
|------|-------------|
| `--force` | Deprecated — sync always overwrites generated files |
| `--skills` | Sync skills only |
| `--instructions` | Sync instruction files only |
| `--model` | Download embedding model only |
| `--platform <name>` | Sync specific platform (claude, gemini, copilot, agents, cursor, antigravity) |

## Auto-Setup Warning

When running any `knowns` command in a project where semantic search is configured but the model is not installed, a warning is shown:

```
⚠ This project uses semantic search but the embedding model is not installed locally.
  Model: GTE Small (gte-small, ~67MB)

  Run: knowns sync
```

## Config Fields Used

| Config field | Sync action |
|---|---|
| `settings.platforms` | Which platform dirs to sync skills/instructions to |
| `settings.gitTrackingMode` | Which `.knowns/.gitignore` mode to apply |
| `settings.gitTracking` | Per-section git tracking toggles for tasks, docs, templates, decisions, and memories |
| `settings.semanticSearch.model` | Which embedding model to download |
| `settings.semanticSearch.enabled` | Whether to download model and reindex |
| `settings.autoSyncOnUpdate` | Whether to auto-sync skills on CLI version change |

## Git Tracking Modes

| Mode | Behavior |
|------|----------|
| `git-tracked` | Tracks durable `.knowns/` project knowledge by default, while ignoring runtime/cache files and sections explicitly disabled in `settings.gitTracking`. |
| `git-ignored` | Ignores `.knowns/` by default, then tracks `config.json` plus enabled sections. Defaults: docs, templates, tasks, and decisions tracked; memories ignored. |
| `none` | Removes the managed `.knowns/.gitignore`; user manages tracking manually. |

## Related

- @doc/features/git-modes — git tracking behavior and section toggles
- `knowns init` — interactive wizard for first-time setup
- `knowns init --force` — re-run wizard with existing config as defaults
- `knowns search --reindex` — rebuild search index only
- `knowns model download <id>` — download a specific model
