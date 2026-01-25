---
title: Template Examples
createdAt: '2026-01-23T04:00:57.742Z'
updatedAt: '2026-01-23T04:03:21.913Z'
description: 'Example templates: React component, API endpoint, CLI command'
tags:
  - feature
  - template
  - examples
---
## Overview

Các ví dụ templates cho Knowns CLI.

**Related docs:**
- @doc/templates/overview - Overview
- @doc/templates/config - Configuration

---

## React Component

### `_template.yaml`

```yaml
name: react-component
description: Create a React functional component
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

  - name: withStyles
    type: confirm
    message: "Include styles?"
    initial: false

actions:
  - type: add
    template: "{{pascalCase name}}.tsx.hbs"
    path: "{{pascalCase name}}.tsx"

  - type: add
    template: "{{pascalCase name}}.test.tsx.hbs"
    path: "{{pascalCase name}}.test.tsx"
    when: "{{withTest}}"

  - type: add
    template: "{{pascalCase name}}.module.css.hbs"
    path: "{{pascalCase name}}.module.css"
    when: "{{withStyles}}"

  - type: append
    path: "../index.ts"
    template: "export { {{pascalCase name}} } from \"./{{pascalCase name}}\";
"
    unique: true
```

### `{{pascalCase name}}.tsx.hbs`

```handlebars
import React from "react";
{{#if withStyles}}
import styles from "./{{pascalCase name}}.module.css";
{{/if}}

export interface {{pascalCase name}}Props {
  children?: React.ReactNode;
}

export function {{pascalCase name}}({ children }: {{pascalCase name}}Props) {
  return (
    <div{{#if withStyles}} className={styles.container}{{/if}}>
      {children}
    </div>
  );
}

export default {{pascalCase name}};
```

### `{{pascalCase name}}.test.tsx.hbs`

```handlebars
import { render, screen } from "@testing-library/react";
import { {{pascalCase name}} } from "./{{pascalCase name}}";

describe("{{pascalCase name}}", () => {
  it("renders children", () => {
    render(<{{pascalCase name}}>Hello</{{pascalCase name}}>);
    expect(screen.getByText("Hello")).toBeInTheDocument();
  });
});
```

---

## API Endpoint

### `_template.yaml`

```yaml
name: api-endpoint
description: Create REST API endpoint with validation
destination: src/api

prompts:
  - name: name
    type: text
    message: "Endpoint name? (e.g., users, products)"

  - name: methods
    type: multiselect
    message: "HTTP methods?"
    choices:
      - { title: "GET", value: "get", selected: true }
      - { title: "POST", value: "post", selected: true }
      - { title: "PUT", value: "put" }
      - { title: "DELETE", value: "delete" }

  - name: withValidation
    type: confirm
    message: "Include request validation?"
    initial: true

actions:
  - type: add
    template: "route.ts.hbs"
    path: "routes/{{kebabCase name}}.ts"

  - type: add
    template: "handler.ts.hbs"
    path: "handlers/{{kebabCase name}}.handler.ts"

  - type: add
    template: "schema.ts.hbs"
    path: "schemas/{{kebabCase name}}.schema.ts"
    when: "{{withValidation}}"
```

### `route.ts.hbs`

```handlebars
import { Router } from "express";
import { {{camelCase name}}Handler } from "../handlers/{{kebabCase name}}.handler";
{{#if withValidation}}
import { validate } from "../middleware/validate";
import { {{camelCase name}}Schema } from "../schemas/{{kebabCase name}}.schema";
{{/if}}

const router = Router();

{{#each methods}}
{{#if (eq this "get")}}
router.get("/{{kebabCase ../name}}", {{camelCase ../name}}Handler.list);
router.get("/{{kebabCase ../name}}/:id", {{camelCase ../name}}Handler.getById);
{{/if}}
{{#if (eq this "post")}}
router.post("/{{kebabCase ../name}}"{{#if ../withValidation}}, validate({{camelCase ../name}}Schema.create){{/if}}, {{camelCase ../name}}Handler.create);
{{/if}}
{{#if (eq this "put")}}
router.put("/{{kebabCase ../name}}/:id"{{#if ../withValidation}}, validate({{camelCase ../name}}Schema.update){{/if}}, {{camelCase ../name}}Handler.update);
{{/if}}
{{#if (eq this "delete")}}
router.delete("/{{kebabCase ../name}}/:id", {{camelCase ../name}}Handler.delete);
{{/if}}
{{/each}}

export { router as {{camelCase name}}Router };
```

---

## Knowns CLI Command (Meta)

### `_template.yaml`

```yaml
name: knowns-command
description: Create a new Knowns CLI command
destination: src/commands

prompts:
  - name: name
    type: text
    message: "Command name?"

  - name: description
    type: text
    message: "Command description?"

  - name: hasSubcommands
    type: confirm
    message: "Has subcommands?"
    initial: false

actions:
  - type: add
    template: "command.ts.hbs"
    path: "{{kebabCase name}}.ts"

  - type: modify
    path: "index.ts"
    pattern: "// COMMAND_IMPORTS"
    template: |
      // COMMAND_IMPORTS
      import { {{camelCase name}}Command } from "./{{kebabCase name}}";

  - type: modify
    path: "index.ts"
    pattern: "// COMMAND_REGISTER"
    template: |
      // COMMAND_REGISTER
      program.addCommand({{camelCase name}}Command);
```

### `command.ts.hbs`

```handlebars
import { Command } from "commander";

{{#if hasSubcommands}}
export const {{camelCase name}}Command = new Command("{{kebabCase name}}")
  .description("{{description}}");

// Add subcommands
const listCommand = new Command("list")
  .description("List all items")
  .action(async () => {
    // Implementation
  });

{{camelCase name}}Command.addCommand(listCommand);
{{else}}
export const {{camelCase name}}Command = new Command("{{kebabCase name}}")
  .description("{{description}}")
  .argument("[arg]", "Optional argument")
  .option("-o, --option <value>", "Option description")
  .action(async (arg, options) => {
    // Implementation
  });
{{/if}}
```

---

## Feature Module

### `_template.yaml`

```yaml
name: feature-module
description: Complete feature module with component, hooks, types
destination: src/features

prompts:
  - name: name
    type: text
    message: "Feature name?"

actions:
  - type: addMany
    source: "{{kebabCase name}}/"
    destination: "{{kebabCase name}}/"
```

### Structure

```
feature-module/
├── _template.yaml
└── {{kebabCase name}}/
    ├── index.ts.hbs
    ├── {{pascalCase name}}.tsx.hbs
    ├── {{pascalCase name}}.test.tsx.hbs
    ├── hooks/
    │   └── use{{pascalCase name}}.ts.hbs
    └── types/
        └── index.ts.hbs
```

---

## Usage Examples

```bash
# Create React component
$ knowns template run react-component
? Component name? UserProfile
? Include test? Yes
? Include styles? No
✓ Created src/components/UserProfile.tsx
✓ Created src/components/UserProfile.test.tsx

# Create API endpoint
$ knowns template run api-endpoint
? Endpoint name? products
? HTTP methods? GET, POST, PUT, DELETE
? Include validation? Yes
✓ Created src/api/routes/products.ts
✓ Created src/api/handlers/products.handler.ts
✓ Created src/api/schemas/products.schema.ts

# Create feature module
$ knowns template run feature-module
? Feature name? shopping-cart
✓ Created src/features/shopping-cart/index.ts
✓ Created src/features/shopping-cart/ShoppingCart.tsx
✓ Created src/features/shopping-cart/hooks/useShoppingCart.ts
```
