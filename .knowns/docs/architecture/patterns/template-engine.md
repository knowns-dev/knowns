---
title: Template Engine Architecture
createdAt: '2026-01-25T09:48:44.135Z'
updatedAt: '2026-01-25T09:49:30.905Z'
description: Internal architecture of the template engine for developers
tags:
  - pattern
  - template
  - architecture
---
## Overview

Template Engine là core module xử lý code generation trong Knowns. Document này mô tả internal architecture cho developers.

**Related:**
- @doc/templates/overview - User-facing overview
- @doc/templates/config - Config format

---

## Architecture Diagram

```
src/templates/engine/
├── models.ts          # TypeScript interfaces
├── schema.ts          # Zod validation schemas
├── parser.ts          # YAML config + file discovery
├── renderer.ts        # Handlebars rendering
├── runner.ts          # Execution orchestration (main entry)
├── helpers.ts         # 30+ built-in Handlebars helpers
├── skill-parser.ts    # SKILL.md parsing
├── skill-sync.ts      # Multi-platform sync
└── index.ts           # Public API exports
```

---

## Execution Flow

```
1. User runs:   knowns template run my-template --name UserProfile
                    ↓
2. Load:        parser.ts → load _template.yaml + discover .hbs files
                    ↓
3. Validate:    schema.ts → validate against Zod schemas
                    ↓
4. Prompt:      runner.ts → collect values (skip if pre-filled)
                    ↓
5. Process:     For each action:
                  a. Evaluate "when" condition
                  b. Render paths with context
                  c. Render template content
                  d. Write/modify files
                    ↓
6. Report:      Return TemplateResult (created, modified, skipped, errors)
```

---

## Core Modules

### 1. Models (`models.ts`)

Defines TypeScript interfaces:

```typescript
// Main config structure
interface TemplateConfig {
  name: string;
  description?: string;
  version?: string;
  destination?: string;
  doc?: string;
  prompts?: TemplatePrompt[];
  actions: TemplateAction[];
  messages?: { success?: string; failure?: string };
}

// Prompt types
interface TemplatePrompt {
  name: string;
  type: 'text' | 'confirm' | 'select' | 'multiselect' | 'number';
  message: string;
  initial?: any;
  validate?: string;
  when?: string;
  choices?: PromptChoice[];
}

// Action types (discriminated union)
type TemplateAction = AddAction | AddManyAction | ModifyAction | AppendAction;
```

### 2. Schema Validation (`schema.ts`)

Zod schemas with two validation modes:

```typescript
// Strict - throws on error (internal code)
validateTemplateConfig(config);

// Safe - returns { success, error } (CLI/UI)
const result = safeValidateTemplateConfig(config);
if (!result.success) {
  console.error(result.error.issues);
}
```

### 3. Parser (`parser.ts`)

Loads and discovers template files:

```typescript
// Load template from directory
const template = await loadTemplate('./my-template');

// List all templates
const templates = await listTemplates('.knowns/templates');

// Quick config check
const isValid = await isValidTemplate('./my-template');
```

### 4. Renderer (`renderer.ts`)

Handlebars rendering with singleton pattern:

```typescript
// Singleton - helpers registered once
let handlebarsInstance: typeof Handlebars | null = null;

function getHandlebars(): typeof Handlebars {
  if (!handlebarsInstance) {
    handlebarsInstance = Handlebars.create();
    registerHelpers(handlebarsInstance);
  }
  return handlebarsInstance;
}

// Render functions
renderString(template, context);     // Render string
renderFile(templatePath, context);   // Render from file
renderPath(pattern, context);        // Render path (removes .hbs)
evaluateCondition(when, context);    // Evaluate when conditions
```

### 5. Runner (`runner.ts`)

Main orchestration - the entry point:

```typescript
// Run by template object
const result = await runTemplate(template, {
  projectRoot: process.cwd(),
  values: { name: 'UserProfile' },  // Pre-fill prompts
  dryRun: true,                     // Preview only
  force: false,                     // Overwrite existing
  silent: false,                    // Suppress output
});

// Run by name
const result = await runTemplateByName(
  '.knowns/templates',
  'react-component',
  options
);

// Result structure
interface TemplateResult {
  success: boolean;
  created: string[];    // Files created
  modified: string[];   // Files modified
  skipped: string[];    // Files skipped
  errors: string[];     // Error messages
}
```

---

## Design Patterns

### 1. Singleton Pattern (Handlebars)

```typescript
// Ensures helpers registered once, reused across renders
let handlebarsInstance: typeof Handlebars | null = null;

function getHandlebars(): typeof Handlebars {
  if (!handlebarsInstance) {
    handlebarsInstance = Handlebars.create();
    registerHelpers(handlebarsInstance);
  }
  return handlebarsInstance;
}
```

### 2. Discriminated Union (Actions)

```typescript
type TemplateAction = 
  | { type: 'add'; template: string; path: string; ... }
  | { type: 'addMany'; source: string; destination: string; ... }
  | { type: 'modify'; path: string; pattern: string; ... }
  | { type: 'append'; path: string; template: string; ... };

// Pattern matching
switch (action.type) {
  case 'add': await executeAddAction(action, context);
  case 'addMany': await executeAddManyAction(action, context);
  case 'modify': await executeModifyAction(action, context);
  case 'append': await executeAppendAction(action, context);
}
```

### 3. Two-Phase Validation

```typescript
// Phase 1: Safe validation for UI
const result = safeValidateTemplateConfig(config);
if (!result.success) {
  return showErrors(result.error);
}

// Phase 2: Strict validation for internal code
const validated = validateTemplateConfig(config); // throws if invalid
```

---

## Built-in Helpers

### Case Conversion
| Helper | Input | Output |
|--------|-------|--------|
| `camelCase` | "user profile" | "userProfile" |
| `pascalCase` | "user profile" | "UserProfile" |
| `kebabCase` | "user profile" | "user-profile" |
| `snakeCase` | "user profile" | "user_profile" |
| `constantCase` | "user profile" | "USER_PROFILE" |
| `titleCase` | "user profile" | "User Profile" |

### String Manipulation
| Helper | Description |
|--------|-------------|
| `lowerCase` | Convert to lowercase |
| `upperCase` | Convert to uppercase |
| `trim` | Trim whitespace |
| `replace` | Find and replace |
| `concat` | Concatenate strings |

### Pluralization
| Helper | Input | Output |
|--------|-------|--------|
| `pluralize` | "user" | "users" |
| `singularize` | "users" | "user" |

### Comparison
| Helper | Description |
|--------|-------------|
| `eq` | Equal |
| `ne` | Not equal |
| `gt` | Greater than |
| `gte` | Greater than or equal |
| `lt` | Less than |
| `lte` | Less than or equal |

### Logical
| Helper | Description |
|--------|-------------|
| `and` | Logical AND |
| `or` | Logical OR |
| `not` | Logical NOT |

### Array
| Helper | Description |
|--------|-------------|
| `includes` | Check if array includes value |
| `join` | Join array with separator |

---

## Skill System

### Skill Parser (`skill-parser.ts`)

Parses SKILL.md files with YAML frontmatter:

```typescript
interface Skill {
  name: string;
  description: string;
  triggers?: string[];
  content: string;        // Markdown content
}

// Load skill
const skill = await loadSkill('.knowns/skills/my-skill');

// List skills
const skills = await listSkills('.knowns/skills');
```

### Multi-Platform Sync (`skill-sync.ts`)

Syncs skills to 6 AI platforms:

| Platform | Directory | Format | MCP |
|----------|-----------|--------|-----|
| Claude Code | `.claude/skills/` | SKILL.md | ✅ |
| Antigravity | `.agent/skills/` | SKILL.md | ✅ |
| Cursor | `.cursor/rules/` | SKILL.md | ✅ |
| Gemini CLI | `~/.gemini/` | GEMINI.md | ✅ |
| Windsurf | `.windsurfrules` | Single file | ⚠️ |
| Cline | `.clinerules/` | SKILL.md | ✅ |

---

## Error Handling

### TemplateParseError

```typescript
class TemplateParseError extends Error {
  constructor(
    message: string,
    public issues: ZodIssue[],  // Validation issues
    public path?: string        // File path
  ) {
    super(message);
  }
}
```

### Graceful Degradation

```typescript
// Actions with skipIfExists
if (action.skipIfExists && existsSync(targetPath)) {
  result.skipped.push(targetPath);
  continue;
}

// Conditional actions
if (action.when && !evaluateCondition(action.when, context)) {
  continue;
}
```

---

## Extension Points

### Custom Helpers

```typescript
// In helpers.ts
export function registerHelpers(handlebars: typeof Handlebars) {
  // Add custom helper
  handlebars.registerHelper('myHelper', (value) => {
    return value.toUpperCase();
  });
}
```

### Custom Actions

Extend `TemplateAction` union and add handler in `runner.ts`:

```typescript
// In models.ts
interface CustomAction {
  type: 'custom';
  handler: string;
  // ...
}

// In runner.ts
case 'custom': await executeCustomAction(action, context);
```

---

## Testing

```bash
# Run all template engine tests
bun test src/templates/engine/

# Run specific test file
bun test src/templates/engine/runner.test.ts
```

Test coverage includes:
- Parser: Config loading, file discovery, validation
- Renderer: String/file rendering, path patterns, conditions
- Runner: Full execution flow, dry-run, force mode
- Helpers: All 30+ helpers with edge cases

---

## Best Practices

1. **Use types**: All template data is strongly typed
2. **Validate early**: Use Zod schemas before processing
3. **Singleton Handlebars**: Don't create multiple instances
4. **Dry-run first**: Test templates before writing files
5. **Handle errors gracefully**: Use `safeValidate` for user input
