---
title: Command Reference
createdAt: '2026-02-24T08:44:32.957Z'
updatedAt: '2026-02-24T08:44:32.957Z'
description: Quick reference for all Knowns CLI commands
tags:
  - guide
  - cli
  - commands
  - reference
---
# Command Reference

Quick reference for Knowns CLI commands. Full docs: `./docs/commands.md`

## Task Commands

```bash
# View
knowns task <id> --plain
knowns task list --plain
knowns task list --status in-progress --plain

# Create
knowns task create "Title" -d "Description" --ac "Criterion" -l "labels"

# Edit
knowns task edit <id> -s in-progress -a @me
knowns task edit <id> --check-ac 1       # Check AC
knowns task edit <id> --plan "1. Step"   # Set plan
knowns task edit <id> --append-notes "Progress"
```

## Doc Commands

```bash
# View
knowns doc <path> --plain
knowns doc list --plain
knowns doc <path> --smart --plain        # Auto-handle large docs
knowns doc <path> --section "2" --plain  # Specific section

# Create/Edit
knowns doc create "Title" -d "Description" -f "folder"
knowns doc edit "path" -c "New content"
knowns doc edit "path" -a "Appended"
```

## Search Commands

```bash
knowns search "query" --plain
knowns search "query" --type task --plain
knowns search "query" --type doc --plain
knowns search reindex                    # Rebuild index
knowns search status                     # Check status
```

## Time Commands

```bash
knowns time start <id>
knowns time stop
knowns time status
knowns time report --from "2025-01-01"
```

## Template Commands

```bash
knowns template list
knowns template run <name> --name "X"
knowns template create <name>
```

## Model Commands

```bash
knowns model list
knowns model download <name>
knowns model remove <name>
```

## Other Commands

```bash
knowns validate                          # Check broken refs
knowns validate --sdd                    # SDD validation
knowns import sync                       # Sync imports
knowns agents sync                       # Sync AI guidelines
knowns browser                           # Open Web UI
```
