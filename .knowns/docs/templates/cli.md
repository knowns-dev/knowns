---
title: Template CLI
createdAt: '2026-01-23T04:00:56.085Z'
updatedAt: '2026-01-23T04:01:57.830Z'
description: CLI commands for template management
tags:
  - feature
  - template
  - cli
---
## Overview

CLI commands cho template management trong Knowns.

**Related docs:**
- @doc/templates/overview - Overview
- @doc/templates/config - Configuration
- @doc/templates/examples - Examples

---

## Commands

### `knowns template list`

Liệt kê tất cả templates:

```bash
$ knowns template list

Templates:
┌──────────────────┬─────────────────────────────────────┐
│ Name             │ Description                         │
├──────────────────┼─────────────────────────────────────┤
│ react-component  │ React functional component          │
│ api-endpoint     │ REST API endpoint with handler      │
│ feature-module   │ Complete feature module             │
└──────────────────┴─────────────────────────────────────┘

$ knowns template list --plain
react-component - React functional component
api-endpoint - REST API endpoint with handler
feature-module - Complete feature module
```

---

### `knowns template run <name>`

Chạy template generator:

```bash
# Interactive mode
$ knowns template run react-component
? Component name? UserProfile
? Include test file? Yes
? Include styles? No

✓ Created src/components/UserProfile.tsx
✓ Created src/components/UserProfile.test.tsx

# Non-interactive (pre-filled answers)
$ knowns template run react-component \
    --name UserProfile \
    --withTest \
    --no-withStyles

# Dry run (preview only)
$ knowns template run react-component --dry-run
Would create:
  - src/components/UserProfile.tsx
  - src/components/UserProfile.test.tsx
```

---

### `knowns template create <name>`

Tạo template mới:

```bash
$ knowns template create my-service

✓ Created .knowns/templates/my-service/_template.yaml
✓ Created .knowns/templates/my-service/example.ts.hbs

Edit _template.yaml to configure prompts and actions.
```

---

### `knowns template view <name>`

Xem chi tiết template:

```bash
$ knowns template view react-component

Template: react-component
Description: React functional component with optional test and styles

Prompts:
  1. name (text) - Component name?
  2. withTest (confirm) - Include test file? [default: yes]
  3. withStyles (confirm) - Include styles? [default: no]

Actions:
  1. add: {{pascalCase name}}.tsx
  2. add: {{pascalCase name}}.test.tsx (when: withTest)
  3. add: {{pascalCase name}}.module.css (when: withStyles)

Linked Doc: patterns/react-component

Files:
  - {{pascalCase name}}.tsx.hbs (1.2KB)
  - {{pascalCase name}}.test.tsx.hbs (0.8KB)
  - {{pascalCase name}}.module.css.hbs (0.2KB)

# With linked doc content
$ knowns template view react-component --with-doc
```

---

### `knowns template validate <name>`

Validate template config:

```bash
$ knowns template validate react-component

✓ Config file valid
✓ All template files exist
✓ Handlebars syntax valid
✓ All prompt names used in templates

Template is valid\!
```

---

### `knowns template doc <name>`

Mở linked doc của template:

```bash
$ knowns template doc react-component
# Equivalent to: knowns doc "patterns/react-component" --plain
```

---

## Skill Management

### `knowns skill list`

```bash
$ knowns skill list

Skills:
┌──────────────────┬─────────────────────────────────────┐
│ Name             │ Description                         │
├──────────────────┼─────────────────────────────────────┤
│ knowns-task      │ Work on Knowns tasks                │
│ knowns-template  │ Generate from templates             │
│ create-component │ Create React component              │
└──────────────────┴─────────────────────────────────────┘
```

### `knowns skill create <name>`

```bash
$ knowns skill create my-skill

✓ Created .knowns/skills/my-skill/SKILL.md

Edit SKILL.md to define skill instructions.
```

### `knowns skill sync`

Sync skills to all AI platforms:

```bash
$ knowns skill sync

Syncing skills to configured platforms...
✓ Claude Code: .claude/skills/ (12 skills)
✓ Antigravity: .agent/skills/ (12 skills)
✓ Cursor: .cursor/rules/ (12 rules)
✓ Gemini CLI: ~/.gemini/commands/ (12 commands)

# Sync to specific platforms
$ knowns skill sync --platform claude,antigravity

# Check status
$ knowns skill status

Platform        Location              Skills    Status
──────────────────────────────────────────────────────
Claude Code     .claude/skills/       12        ✅ Synced
Antigravity     .agent/skills/        12        ✅ Synced
Cursor          .cursor/rules/        12        ✅ Synced
Gemini CLI      ~/.gemini/commands/   12        ✅ Synced
```

### `knowns skill export`

Export skills to specific platform format:

```bash
$ knowns skill export --platform cursor
$ knowns skill export --platform antigravity
$ knowns skill export --platform gemini
$ knowns skill export --platform all
```

---

## AI Platform Detection

### `knowns ai detect`

```bash
$ knowns ai detect

Detected AI platforms:
  ✓ Claude Code (found .claude/)
  ✓ Antigravity (found .agent/)
  ✓ Cursor (found .cursor/)
  ✗ Gemini CLI (not found)
  ✗ Windsurf (not found)

Recommendation:
  Run `knowns skill sync` to update all platforms.
```

---

## Init với AI Platforms

```bash
# Interactive (asks which platforms)
knowns init

# Specify platforms
knowns init --ai claude,cursor,antigravity

# All supported platforms
knowns init --ai all

# Skip AI setup
knowns init --no-ai
```
