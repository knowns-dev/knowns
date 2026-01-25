---
title: Template Config
createdAt: '2026-01-23T04:00:55.418Z'
updatedAt: '2026-01-23T04:01:30.456Z'
description: 'Template configuration, prompts, actions, and Handlebars syntax'
tags:
  - feature
  - template
  - config
---
## Overview

Tài liệu này mô tả cấu trúc và cấu hình của templates trong Knowns CLI.

**Related docs:**
- @doc/templates/overview - Overview
- @doc/templates/cli - CLI Commands
- @doc/templates/examples - Examples

---

## Template Structure

Mỗi template là một folder chứa config file và template files:

```
.knowns/templates/
├── react-component/                    # Template folder
│   ├── _template.yaml                  # Config file (prompts, actions)
│   ├── {{pascalCase name}}.tsx.hbs     # Template file
│   ├── {{pascalCase name}}.test.tsx.hbs
│   └── {{pascalCase name}}.module.css.hbs
│
├── api-endpoint/
│   ├── _template.yaml
│   ├── routes/
│   │   └── {{kebabCase name}}.ts.hbs
│   └── handlers/
│       └── {{kebabCase name}}.handler.ts.hbs
│
└── knowns-command/
    ├── _template.yaml
    └── {{kebabCase name}}.ts.hbs
```

---

## Config File: `_template.yaml`

```yaml
# Metadata
name: react-component
description: Create a React functional component
version: 1.0.0
author: "@me"

# Destination base path (relative to project root)
destination: src/components

# Link to documentation
doc: patterns/react-component

# Interactive prompts
prompts:
  - name: name
    type: text
    message: "Component name?"
    validate: required
    
  - name: withTest
    type: confirm
    message: "Include test file?"
    initial: true
    
  - name: styleType
    type: select
    message: "Style type?"
    choices:
      - { title: "CSS Module", value: "css" }
      - { title: "SCSS Module", value: "scss" }
    when: "{{withStyles}}"

# File generation actions
actions:
  - type: add
    template: "{{pascalCase name}}.tsx.hbs"
    path: "{{pascalCase name}}.tsx"
    
  - type: add
    template: "{{pascalCase name}}.test.tsx.hbs"
    path: "{{pascalCase name}}.test.tsx"
    when: "{{withTest}}"

# Success message
messages:
  success: |
    Component {{pascalCase name}} created!
    Import: import { {{pascalCase name}} } from "./components/{{pascalCase name}}"
```

---

## Prompt Types

| Type | Description | Example |
|------|-------------|---------|
| `text` | Free text input | Component name |
| `confirm` | Yes/No boolean | Include tests? |
| `select` | Single choice | Choose framework |
| `multiselect` | Multiple choices | Select features |
| `number` | Numeric input | Port number |

### Prompt Options

```yaml
prompts:
  - name: componentName
    type: text
    message: "Component name?"
    initial: "MyComponent"        # Default value
    validate: required            # Validation rule
    hint: "Use PascalCase"        # Help text

  - name: framework
    type: select
    message: "Framework?"
    choices:
      - { title: "React", value: "react", description: "React 18+" }
      - { title: "Vue", value: "vue", description: "Vue 3" }
    initial: 0                    # Default selection index

  - name: features
    type: multiselect
    message: "Features?"
    choices:
      - { title: "TypeScript", value: "ts", selected: true }
      - { title: "Testing", value: "test" }
      - { title: "Storybook", value: "story" }
```

### Conditional Prompts

```yaml
prompts:
  - name: withStyles
    type: confirm
    message: "Include styles?"

  - name: styleType
    type: select
    message: "Style type?"
    when: "{{withStyles}}"        # Only show if withStyles is true
    choices:
      - { title: "CSS Modules", value: "css" }
      - { title: "Styled Components", value: "styled" }
```

---

## Template Files (Handlebars)

### Syntax

```handlebars
{{!-- Comment: không xuất hiện trong output --}}

{{!-- Variable interpolation --}}
export function {{pascalCase name}}() {
  return <div>{{name}}</div>;
}

{{!-- Conditional blocks --}}
{{#if withStyles}}
import styles from "./{{pascalCase name}}.module.css";
{{/if}}

{{!-- Negation --}}
{{#unless isSimple}}
// Complex implementation
{{/unless}}

{{!-- Loops --}}
{{#each fields}}
  {{this.name}}: {{this.type}};
{{/each}}
```

### Built-in Helpers

| Helper | Input | Output |
|--------|-------|--------|
| `pascalCase` | "user profile" | "UserProfile" |
| `camelCase` | "user profile" | "userProfile" |
| `kebabCase` | "user profile" | "user-profile" |
| `snakeCase` | "user profile" | "user_profile" |
| `constantCase` | "user profile" | "USER_PROFILE" |
| `titleCase` | "user profile" | "User Profile" |
| `lowerCase` | "User Profile" | "user profile" |
| `upperCase` | "user profile" | "USER PROFILE" |
| `pluralize` | "user" | "users" |
| `singularize` | "users" | "user" |

### File Naming

File names cũng dùng Handlebars syntax:

```
{{pascalCase name}}.tsx.hbs        → UserProfile.tsx
{{kebabCase name}}.service.ts.hbs  → user-profile.service.ts
{{snakeCase name}}_test.py.hbs     → user_profile_test.py
```

**Note:** Extension `.hbs` được remove sau khi render.

---

## Actions

### `add` - Create Single File

```yaml
actions:
  - type: add
    template: "component.tsx.hbs"    # Source template
    path: "{{pascalCase name}}.tsx"  # Destination path
    skipIfExists: true               # Không overwrite
    when: "{{condition}}"            # Conditional
```

### `addMany` - Create Multiple Files

```yaml
actions:
  - type: addMany
    source: "feature/"               # Template folder
    destination: "{{kebabCase name}}/"
    globPattern: "**/*.hbs"
```

### `modify` - Edit Existing File

```yaml
actions:
  - type: modify
    path: "src/index.ts"
    pattern: "// EXPORTS"
    template: |
      // EXPORTS
      export * from "./{{pascalCase name}}";
```

### `append` - Add to End of File

```yaml
actions:
  - type: append
    path: "src/components/index.ts"
    template: |
      export { {{pascalCase name}} } from "./{{pascalCase name}}";
    unique: true                     # Không duplicate
```

---

## Template-Doc Linking

Templates có thể link với Knowns docs:

### In Template Config

```yaml
# _template.yaml
name: react-component
doc: patterns/react-component    # Link to Knowns doc
```

### In Knowns Doc

```markdown
# React Component Pattern

**Template reference:** @template/react-component
```

### Reference Formats

| Context | Format |
|---------|--------|
| Doc → Template | `@template/<name>` |
| Template → Doc | `doc: <path>` field |
