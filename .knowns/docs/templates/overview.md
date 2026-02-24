---
title: Template System
createdAt: '2026-01-23T03:40:02.075Z'
updatedAt: '2026-01-25T09:49:42.347Z'
description: Design documentation for the lightweight template/scaffolding system
tags:
  - feature
  - design
  - template
---
## Overview

Template System is a lightweight code generator that allows creating files/folders from predefined templates. Inspired by [Plop.js](https://plopjs.com/) but designed simpler, suitable for Knowns patterns.

### Problem Statement

When working with codebases, developers often have to:
- Copy-paste code from old files and modify
- Remember folder structure for each file type
- Ensure naming conventions are consistent
- Create multiple related files (component + test + styles)

Template System solves this by allowing definition of **generators** - sets of prompts + templates to create code consistently.

### Goals

- **Simple**: Easy to create and maintain templates
- **Local-first**: Templates stored in project, versioned with git
- **Interactive**: Ask user for required options
- **Flexible**: Support conditional files, nested folders
- **AI-friendly**: Can be used from CLI or MCP tools
- **Multi-platform**: Export skills to Claude, Antigravity, Cursor, Gemini

---

## Architecture

```
.knowns/
├── templates/                   # Code templates
│   ├── react-component/
│   │   ├── _template.yaml       # Config
│   │   └── *.hbs                # Handlebars templates
│   └── api-endpoint/
│
├── skills/                      # AI skills (source of truth)
│   ├── knowns-task/SKILL.md
│   └── create-component/SKILL.md
│
└── docs/                        # Documentation

# Auto-synced to AI platforms
.claude/skills/                  # Claude Code
.agent/skills/                   # Antigravity
.cursor/rules/                   # Cursor
GEMINI.md                        # Gemini CLI
```

---

## Quick Start

```bash
# List templates
knowns template list

# Run template
knowns template run react-component

# Create new template
knowns template create my-template

# Sync skills to AI platforms
knowns skill sync
```

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Templates** | Handlebars-based code generation |
| **Skills** | AI workflow instructions |
| **Multi-AI** | Claude, Antigravity, Cursor, Gemini |
| **Import** | From GitHub, NPM, local |
| **Doc Linking** | Templates ↔ Docs references |

---

## Documentation

| Topic | Doc |
|-------|-----|
| **Config & Syntax** | @doc/templates/config |
| **CLI Commands** | @doc/templates/cli |
| **Import** | @doc/templates/import |
| **AI Platforms** | @doc/ai/platforms |
| **Examples** | @doc/templates/examples |

---

## Supported AI Platforms

| Platform | Skills | MCP |
|----------|--------|-----|
| **Claude Code** | `.claude/skills/` | ✅ |
| **Antigravity** | `.agent/skills/` | ✅ |
| **Gemini CLI** | `~/.gemini/commands/` | ✅ |
| **Cursor** | `.cursor/rules/` | ✅ |
| **Windsurf** | `.windsurfrules` | ⚠️ |
| **Cline** | `.clinerules/` | ✅ |

> **Note:** Claude Code and Antigravity use the same SKILL.md format - portable\!

---

## Template-Doc Linking

```yaml
# In _template.yaml
doc: patterns/react-component
```

```markdown
# In doc
@template/react-component
```

AI can follow links to understand context before generating.

---

## Import from External Sources

```bash
# GitHub
knowns template import github:company/templates/react@v1.0

# Local
knowns template import file:../shared-templates/component

# NPM
knowns template import npm:@company/templates
```

---

## Best Practices

1. **Single source of truth**: Define skills in `.knowns/skills/`, sync to platforms
2. **Link templates to docs**: AI understands context better
3. **Use version tags**: When importing from external sources
4. **Keep templates simple**: One template = one purpose

---

## Related Documentation

- @doc/architecture/patterns/command - CLI command structure
- @doc/architecture/patterns/storage - File storage patterns
- @doc/development/developer-guide - Development workflow



---

## Internal Architecture

For developers working on the template engine codebase:

→ @doc/architecture/patterns/template-engine

Covers:
- Module structure (parser, renderer, runner, helpers)
- Execution flow
- Design patterns (Singleton, Discriminated Union, Two-Phase Validation)
- All 30+ built-in Handlebars helpers
- Extension points
