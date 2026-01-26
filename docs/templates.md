# Template System

Code generation and scaffolding system for Knowns CLI.

## Overview

Template System is a lightweight code generator that creates files/folders from predefined templates. Inspired by [Plop.js](https://plopjs.com/) but designed simpler, optimized for AI-assisted workflows.

### Features

- **Interactive prompts** - Ask user for required inputs
- **Handlebars syntax** - Powerful templating with built-in helpers
- **Conditional files** - Generate files based on user choices
- **Template-Doc linking** - Link templates to documentation
- **AI-friendly** - Use from CLI or MCP tools
- **Multi-platform** - Sync skills to Claude, Cursor, Gemini

---

## Quick Start

```bash
# List available templates
knowns template list

# Run a template (interactive)
knowns template run react-component

# Run with pre-filled answers
knowns template run react-component --name UserProfile --withTest

# Preview without creating files
knowns template run react-component --dry-run

# Create a new template
knowns template create my-template
```

---

## Template Structure

```
.knowns/templates/
├── react-component/                    # Template folder
│   ├── _template.yaml                  # Config (prompts, actions)
│   ├── {{pascalCase name}}.tsx.hbs     # Template files
│   ├── {{pascalCase name}}.test.tsx.hbs
│   └── {{pascalCase name}}.module.css.hbs
│
└── api-endpoint/
    ├── _template.yaml
    └── routes/
        └── {{kebabCase name}}.ts.hbs
```

---

## Config File: `_template.yaml`

```yaml
name: react-component
description: Create a React functional component
version: 1.0.0

# Base destination path
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
    validate: required            # Validation
    hint: "Use PascalCase"        # Help text

  - name: framework
    type: select
    message: "Framework?"
    choices:
      - { title: "React", value: "react" }
      - { title: "Vue", value: "vue" }
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
```

---

## Handlebars Templates

### Syntax

```handlebars
{{!-- Comment --}}

{{!-- Variable interpolation --}}
export function {{pascalCase name}}() {
  return <div>{{name}}</div>;
}

{{!-- Conditional blocks --}}
{{#if withStyles}}
import styles from "./{{pascalCase name}}.module.css";
{{/if}}

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

File names also use Handlebars:

```
{{pascalCase name}}.tsx.hbs        → UserProfile.tsx
{{kebabCase name}}.service.ts.hbs  → user-profile.service.ts
```

The `.hbs` extension is removed after rendering.

---

## Actions

### `add` - Create Single File

```yaml
actions:
  - type: add
    template: "component.tsx.hbs"
    path: "{{pascalCase name}}.tsx"
    skipIfExists: true
    when: "{{condition}}"
```

### `addMany` - Create Multiple Files

```yaml
actions:
  - type: addMany
    source: "feature/"
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
    unique: true
```

---

## CLI Commands

### Template Commands

```bash
# List templates
knowns template list
knowns template list --plain

# Run template
knowns template run <name>
knowns template run <name> --dry-run
knowns template run <name> --name Value --flag

# View template details
knowns template view <name>
knowns template view <name> --with-doc

# Create new template
knowns template create <name>

# Validate template
knowns template validate <name>
```

### Skill Commands

```bash
# List skills
knowns skill list

# Create skill
knowns skill create <name>

# Sync to AI platforms
knowns skill sync
knowns skill sync --platform claude,cursor

# Check sync status
knowns skill status
```

---

## Template-Doc Linking

Templates can link to Knowns documentation:

### In Template Config

```yaml
# _template.yaml
doc: patterns/react-component
```

### In Knowns Doc

```markdown
Related template: @template/react-component
```

AI can follow links to understand context before generating.

---

## MCP Tools

For AI agents using MCP:

```json
// List templates
mcp__knowns__list_templates({})

// Get template details
mcp__knowns__get_template({ "name": "react-component" })

// Run template (preview first)
mcp__knowns__run_template({
  "name": "react-component",
  "variables": { "name": "UserProfile", "withTest": true },
  "dryRun": true
})

// Create template
mcp__knowns__create_template({
  "name": "my-template",
  "description": "My custom template",
  "doc": "patterns/my-pattern"
})
```

---

## Example: React Component Template

### `_template.yaml`

```yaml
name: react-component
description: React functional component with TypeScript

destination: src/components

prompts:
  - name: name
    type: text
    message: "Component name?"
    validate: required

  - name: withTest
    type: confirm
    message: "Include test?"
    initial: true

actions:
  - type: add
    template: "component.tsx.hbs"
    path: "{{pascalCase name}}.tsx"

  - type: add
    template: "component.test.tsx.hbs"
    path: "{{pascalCase name}}.test.tsx"
    when: "{{withTest}}"
```

### `component.tsx.hbs`

```handlebars
import React from 'react';

interface {{pascalCase name}}Props {
  className?: string;
}

export function {{pascalCase name}}({ className }: {{pascalCase name}}Props) {
  return (
    <div className={className}>
      {{pascalCase name}}
    </div>
  );
}
```

### `component.test.tsx.hbs`

```handlebars
import { render, screen } from '@testing-library/react';
import { {{pascalCase name}} } from './{{pascalCase name}}';

describe('{{pascalCase name}}', () => {
  it('renders correctly', () => {
    render(<{{pascalCase name}} />);
    expect(screen.getByText('{{pascalCase name}}')).toBeInTheDocument();
  });
});
```

---

## Common Pitfalls

### JavaScript Template Literals + Handlebars

When generating JavaScript/TypeScript code with template literals (`${}`), be careful not to create `${{{` which Handlebars interprets as triple-brace (unescaped output):

```handlebars
{{!-- ❌ WRONG - Handlebars sees {{{ as triple-brace --}}
this.logger.log(`Created with id: ${{{camelCase entity}}.id}`);
{{!-- Parse error: Expecting 'CLOSE_UNESCAPED'... --}}

{{!-- ✅ CORRECT - Add space, use ~ to trim whitespace --}}
this.logger.log(`Created with id: ${ {{~camelCase entity~}}.id}`);
{{!-- Output: this.logger.log(`Created with id: ${product.id}`); --}}
```

**Rules:**
- Never write `${{{` - always add space: `${ {{`
- Use `~` (tilde) to trim whitespace: `{{~helper~}}`
- The `~` removes whitespace on that side of the expression

### Other Syntax Conflicts

```handlebars
{{!-- Escaping literal braces --}}
\{{notHandlebars}}  {{!-- Outputs: {{notHandlebars}} --}}

{{!-- Raw blocks (no processing inside) --}}
{{{{raw}}}}
  This {{will not}} be processed
{{{{/raw}}}}
```

---

## Best Practices

1. **One template = one purpose** - Keep templates focused
2. **Link to docs** - Use `doc:` field for context
3. **Use validation** - Add `validate: required` for important fields
4. **Provide defaults** - Set `initial:` for better UX
5. **Add success messages** - Help users know what to do next
6. **Avoid `${{{`** - When using JS template literals with Handlebars, add space: `${ {{~helper~}}`
