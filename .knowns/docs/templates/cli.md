---
id: doc-d91722891051579bb2c4bc2d8907ef39
title: Template CLI
createdAt: '2026-01-23T04:00:56.085Z'
updatedAt: '2026-03-09T06:39:43.159Z'
description: CLI commands for template management
tags:
  - feature
  - template
  - cli
---
## Overview

CLI commands for template management in Knowns. The CLI is implemented in Go using the `cobra` command framework. Templates use Handlebars (`.hbs`) syntax for code generation and are configured via `_template.yaml` files.

**Related docs:**
- @doc/templates/overview - Overview
- @doc/templates/config - Configuration
- @doc/templates/examples - Examples

---

## Commands

### `knowns template list`

List all templates:

```bash
$ knowns template list

NAME                            DESCRIPTION                               TYPE
────────────────────────────────────────────────────────────────────────────────
react-component                 React functional component                local
api-endpoint                    REST API endpoint with handler            local
knowns/service                  Go service boilerplate                    imported

$ knowns template list --plain
TEMPLATE: react-component
  DESCRIPTION: React functional component

TEMPLATE: api-endpoint
  DESCRIPTION: REST API endpoint with handler

TEMPLATE: knowns/service
  DESCRIPTION: Go service boilerplate
  IMPORTED FROM: knowns
```

Filters:

```bash
# Show only local templates
$ knowns template list --local

# Show only imported templates
$ knowns template list --imported

# JSON output
$ knowns template list --json
```

---

### `knowns template view <name>`

View template details (also available as shorthand `knowns template <name>`):

```bash
$ knowns template view react-component --plain

NAME: react-component
DESCRIPTION: React functional component with optional test and styles
VERSION: 1.0.0
AUTHOR: team
DOC: patterns/react-component
DESTINATION: src/components
PATH: /path/to/.knowns/templates/react-component
PROMPTS:
  - name (text): Component name? [required]
  - withTest (confirm): Include test file? (default: true)
  - withStyles (confirm): Include styles? (default: false)
ACTIONS:
  1. add → {{pascalCase name}}.tsx (template: component.tsx.hbs)
  2. add → {{pascalCase name}}.test.tsx (template: component.test.tsx.hbs)
  3. add → {{pascalCase name}}.module.css (template: styles.css.hbs)
```

Styled output:

```bash
$ knowns template view react-component

react-component
React functional component with optional test and styles

Version: 1.0.0
Author: team
Doc: patterns/react-component
Destination: src/components

── Prompts ──
  - name (text): Component name? [required]
  - withTest (confirm): Include test file? (default: true)
  - withStyles (confirm): Include styles? (default: false)

── Actions (3) ──
  1. [add] {{pascalCase name}}.tsx (template: component.tsx.hbs)
  2. [add] {{pascalCase name}}.test.tsx (template: component.test.tsx.hbs) [skip-if-exists]
  3. [add] {{pascalCase name}}.module.css (template: styles.css.hbs)

Success message: Component created successfully!
```

---

### `knowns template run <name>`

Run template generator. Variables are passed via `-v key=value` flags (repeatable):

```bash
# Pass variables via -v flags
$ knowns template run react-component \
    -v name=UserProfile \
    -v withTest=true \
    -v withStyles=false

Created:
  + src/components/UserProfile.tsx
  + src/components/UserProfile.test.tsx

# Dry run (preview only, no files written)
$ knowns template run react-component -v name=UserProfile --dry-run

Dry run — no files were written.

Created:
  + src/components/UserProfile.tsx
  + src/components/UserProfile.test.tsx
  + src/components/UserProfile.module.css

# JSON output
$ knowns template run react-component -v name=UserProfile --json
```

Variable validation:
- Required prompts without a value (and no default) produce an error
- Optional prompts use their `initial` value as default when not provided

```bash
# Error: required variable not provided
$ knowns template run react-component
Error: required variable "name" not provided (use -v name=<value>)
```

---

### `knowns template create <name>`

Create a new template scaffold:

```bash
$ knowns template create my-service

Created template: my-service
Edit the template at: .knowns/templates/my-service/

# With description and linked doc
$ knowns template create my-service \
    -d "Go service with handler and tests" \
    --doc "patterns/service"

Created template: my-service
Doc: patterns/service
Edit the template at: .knowns/templates/my-service/
```

This creates:
- `.knowns/templates/my-service/_template.yaml` — template configuration
- `.knowns/templates/my-service/example.hbs` — example Handlebars template file

---

---

## Init with AI Platforms

The `knowns init` command automatically generates AI platform instruction files:

```bash
$ knowns init

# Auto-generates:
# - CLAUDE.md          (Claude Code)
# - GEMINI.md          (Gemini CLI)
# - AGENTS.md          (Generic AI)
# - .github/copilot-instructions.md (GitHub Copilot)
```

Each generated file includes project-specific guidelines and CLI command references.

---

## Template Engine

The Go template engine (`internal/codegen`) processes Handlebars `.hbs` files with the following features:

- **Variable substitution**: `{{name}}`, `{{description}}`
- **Case helpers**: `{{pascalCase name}}`, `{{camelCase name}}`, `{{snakeCase name}}`, `{{kebabCase name}}`
- **Conditional rendering**: Actions support `when` expressions
- **Action types**: `add`, `addMany`, `modify`, `append`
- **Skip-if-exists**: Prevents overwriting existing files
- **Dry-run mode**: Preview generated files without writing

### Action Types

| Type | Description | Key Fields |
|------|-------------|------------|
| `add` | Create a single file | `template`, `path` |
| `addMany` | Create multiple files from a folder | `source`, `destination`, `globPattern` |
| `modify` | Edit an existing file in-place | `path`, `pattern`, `template` |
| `append` | Append content to an existing file | `path`, `template`, `unique`, `separator` |
