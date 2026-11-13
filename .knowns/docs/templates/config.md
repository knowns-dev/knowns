---
id: doc-fec7d958c6d0cf0e38d7f35e5bf2dd07
title: Template Config
createdAt: '2026-01-23T04:00:55.418Z'
updatedAt: '2026-03-09T06:40:05.853Z'
description: >-
  Template configuration, prompts, actions, and Handlebars-compatible syntax (Go
  text/template engine)
tags:
  - feature
  - template
  - config
  - go-template
---
## Overview

This document describes the structure and configuration of templates in Knowns CLI.

The template engine is built on Go's `text/template` but accepts **Handlebars-compatible syntax** in `.hbs` files. The engine preprocesses Handlebars expressions (`{{name}}`, `{{#if}}`, `{{#each}}`, etc.) into Go template equivalents before rendering.

**Related docs:**
- @doc/templates/overview - Overview
- @doc/templates/cli - CLI Commands
- @doc/templates/examples - Examples

---

## Template Structure

Each template is a folder containing a config file and template files:

```
.knowns/templates/
├── go-service/                         # Template folder
│   ├── _template.yaml                  # Config file (prompts, actions)
│   ├── {{snakeCase name}}.go.hbs       # Template file
│   └── {{snakeCase name}}_test.go.hbs
│
├── api-handler/
│   ├── _template.yaml
│   ├── routes/
│   │   └── {{snakeCase name}}.go.hbs
│   └── handlers/
│       └── {{snakeCase name}}_handler.go.hbs
│
└── cli-command/
    ├── _template.yaml
    └── {{kebabCase name}}.go.hbs
```

---

## Config File: `_template.yaml`

```yaml
# Metadata
name: go-service
description: Create a Go service with interface and implementation
version: 1.0.0
author: "@me"

# Destination base path (relative to project root)
destination: internal/services

# Link to documentation
doc: patterns/go-service

# Interactive prompts
prompts:
  - name: name
    type: text
    message: "Service name?"
    validate: required

  - name: withTest
    type: confirm
    message: "Include test file?"
    initial: true

  - name: withInterface
    type: confirm
    message: "Generate interface?"
    initial: true

# File generation actions
actions:
  - type: add
    template: "{{snakeCase name}}.go.hbs"
    path: "{{snakeCase name}}.go"

  - type: add
    template: "{{snakeCase name}}_test.go.hbs"
    path: "{{snakeCase name}}_test.go"
    when: "{{withTest}}"

# Success message
messages:
  success: |
    Service {{pascalCase name}} created!
    Import: "your-module/internal/services/{{snakeCase name}}"
```

---

## Prompt Types

| Type | Description | Example |
|------|-------------|---------|
| `text` | Free text input | Service name |
| `confirm` | Yes/No boolean | Include tests? |
| `select` | Single choice | Choose pattern |
| `multiselect` | Multiple choices | Select features |
| `number` | Numeric input | Port number |

### Prompt Options

```yaml
prompts:
  - name: serviceName
    type: text
    message: "Service name?"
    initial: "MyService"           # Default value
    validate: required             # Validation rule
    hint: "Use PascalCase"         # Help text

  - name: pattern
    type: select
    message: "Design pattern?"
    choices:
      - { title: "Repository", value: "repo", description: "Data access layer" }
      - { title: "Service", value: "svc", description: "Business logic" }
    initial: 0                     # Default selection index

  - name: features
    type: multiselect
    message: "Features?"
    choices:
      - { title: "Testing", value: "test", selected: true }
      - { title: "Logging", value: "log" }
      - { title: "Metrics", value: "metrics" }
```

### Conditional Prompts

```yaml
prompts:
  - name: withDatabase
    type: confirm
    message: "Include database layer?"

  - name: dbDriver
    type: select
    message: "Database driver?"
    when: "{{withDatabase}}"       # Only show if withDatabase is true
    choices:
      - { title: "PostgreSQL", value: "postgres" }
      - { title: "SQLite", value: "sqlite" }
```

---

## Template Files (Handlebars-Compatible)

The engine accepts standard Handlebars syntax and preprocesses it into Go `text/template` expressions internally. Template authors write Handlebars; the Go engine handles the translation.

### Syntax

```handlebars
{{!-- Comment: does not appear in output --}}

{{!-- Variable interpolation with case helpers --}}
// Package {{snakeCase name}} implements the {{pascalCase name}} service.
package {{snakeCase name}}

{{!-- Conditional blocks --}}
{{#if withInterface}}
// {{pascalCase name}} defines the service contract.
type {{pascalCase name}} interface {
    Execute(ctx context.Context) error
}
{{/if}}

{{!-- Negation --}}
{{#unless isSimple}}
// Complex implementation with dependency injection
{{/unless}}

{{!-- Loops --}}
{{#each fields}}
  {{this.name}} {{this.type}}
{{/each}}
```

### Built-in Helpers

These case-conversion helpers are registered in the Go `text/template` FuncMap:

| Helper | Input | Output |
|--------|-------|--------|
| `pascalCase` | "user profile" | "UserProfile" |
| `camelCase` | "user profile" | "userProfile" |
| `kebabCase` | "user profile" | "user-profile" |
| `snakeCase` | "user profile" | "user_profile" |
| `upperCase` | "user profile" | "USER PROFILE" |
| `lowerCase` | "User Profile" | "user profile" |
| `startCase` | "userProfile" | "User Profile" |

**Note:** The Go engine does not include `constantCase`, `titleCase`, `pluralize`, or `singularize` helpers. Use `upperCase` with `snakeCase` for constant-style naming if needed.

### File Naming

File names also use Handlebars syntax:

```
{{pascalCase name}}.go.hbs             -> UserProfile.go
{{snakeCase name}}_handler.go.hbs      -> user_profile_handler.go
{{kebabCase name}}-config.yaml.hbs     -> user-profile-config.yaml
```

**Note:** The `.hbs` extension is stripped from output file names after rendering.

---

## Actions

### `add` - Create Single File

```yaml
actions:
  - type: add
    template: "service.go.hbs"           # Source template (.hbs file)
    path: "{{snakeCase name}}.go"        # Destination path (Handlebars in path)
    skipIfExists: true                    # Don't overwrite existing files
    when: "{{condition}}"                 # Conditional execution
```

### `addMany` - Create Multiple Files

```yaml
actions:
  - type: addMany
    source: "feature/"                    # Source template folder
    destination: "{{kebabCase name}}/"    # Output folder
    globPattern: "**/*.hbs"              # File filter (default: **/*.hbs)
```

### `modify` - Edit Existing File

```yaml
actions:
  - type: modify
    path: "internal/registry.go"
    pattern: "// REGISTER_SERVICES"
    template: |
      // REGISTER_SERVICES
      registry.Register({{snakeCase name}}.New{{pascalCase name}}())
```

### `append` - Add to End of File

```yaml
actions:
  - type: append
    path: "internal/services/services.go"
    template: |
      // {{pascalCase name}}Service
      func New{{pascalCase name}}() *{{pascalCase name}}Impl { return &{{pascalCase name}}Impl{} }
    unique: true                          # Don't duplicate
    separator: "
"                       # Separator before appended content
```

---

## Template-Doc Linking

Templates can link with Knowns docs:

### In Template Config

```yaml
# _template.yaml
name: go-service
doc: patterns/go-service     # Link to Knowns doc
```

### In Knowns Doc

```markdown
# Go Service Pattern

**Template reference:** @template/go-service
```

### Reference Formats

| Context | Format |
|---------|--------|
| Doc -> Template | `@template/<name>` |
| Template -> Doc | `doc: <path>` field |
