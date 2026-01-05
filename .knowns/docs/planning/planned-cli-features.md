---
title: Planned CLI Features
createdAt: '2025-12-31T11:33:41.325Z'
updatedAt: '2026-01-03T22:12:48.770Z'
description: Planned features for Knowns CLI enhancements
tags:
  - planning
  - features
  - roadmap
---
# Planned CLI Features

Roadmap for Knowns CLI enhancements to improve AI agent compatibility and data integrity.

## ✅ IMPLEMENTED

### Text Manipulation Commands (Task #46)

* `knowns doc search-in "name" "query"` - Search within doc

* `knowns doc replace "name" "old" "new"` - Replace text

* `knowns doc replace-section "name" "## Header" "content"` - Replace section

### Validate & Repair Commands (Task #47)

* `knowns doc validate "name"` / `knowns doc repair "name"`

* `knowns task validate <id>` / `knowns task repair <id>`

* Graceful skip + warning for corrupted files

### File Input Options (Task #45)

* `knowns doc edit "name" --content-file ./file.md`

* `knowns doc edit "name" --append-file ./file.md`

### Condensed Guidelines (Task #44)

* Created gemini-agent-guidelines.md for smaller context windows

### Doc List Path Filter

* `knowns doc list "guides/"` - Filter by folder

### Agents Sync Command

* `knowns agents sync` - Quick sync of instruction files

* `knowns agents sync --all` - Include all files

## PLANNED (Future)

### --stdin option

Read from stdin for piping.

```bash
cat content.md | knowns doc edit "name" -c --stdin
```

### doc diff / doc history

Show changes and history (requires git).

```bash
knowns doc diff "name"
knowns doc history "name" --limit 10
```

### validate-all / repair-all

Batch validation and repair.

```bash
knowns validate-all
knowns repair-all
```

### export/import

Export/import for backup or migration.

```bash
knowns export --output backup.json
knowns import backup.json
```

### Template System (v0.3+)

* 2x2 matrix: type (cli/mcp) × variant (general/gemini)

* `knowns agents sync --gemini` - Compact variant

* `knowns agents sync --type mcp` - MCP guidelines

* Interactive mode with type/variant selection

* Templates in `src/templates/{cli,mcp}/{general,gemini}.md`

#36

gemini-agent-guidelines

@task-37
