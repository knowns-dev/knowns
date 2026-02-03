---
name: knowns.template
description: Use when generating code from templates - list, run, or create templates
---

# Working with Templates

Generate code from predefined templates stored in `.knowns/templates/`.

**Announce at start:** "I'm using the knowns.template skill to work with templates."

**Core principle:** USE TEMPLATES FOR CONSISTENT CODE GENERATION.

## The Process

### Step 1: List Available Templates

```json
mcp__knowns__list_templates({})
```

### Step 2: Get Template Details

```json
mcp__knowns__get_template({ "name": "<template-name>" })
```

Check:
- Required variables (prompts)
- Linked documentation (`doc:`)
- Files that will be generated

### Step 3: Read Linked Documentation

If template has a `doc:` field, read it first:

```json
mcp__knowns__get_doc({ "path": "<doc-path>", "smart": true })
```

### Step 4: Run Template

```json
// Dry run first (preview)
mcp__knowns__run_template({
  "name": "<template-name>",
  "variables": { "name": "MyComponent", "type": "page" },
  "dryRun": true
})

// Then run for real
mcp__knowns__run_template({
  "name": "<template-name>",
  "variables": { "name": "MyComponent", "type": "page" },
  "dryRun": false
})
```

### Step 5: Create New Template

```json
mcp__knowns__create_template({
  "name": "<template-name>",
  "description": "Template description",
  "doc": "patterns/<related-doc>"  // Optional: link to documentation
})
```

This creates:
```
.knowns/templates/<template-name>/
  ├── _template.yaml    # Config
  └── example.ts.hbs    # Example file
```

## Template Config (`_template.yaml`)

```yaml
name: react-component
description: Create a React component with tests
doc: patterns/react-component    # Link to documentation

prompts:
  - name: name
    message: Component name?
    validate: required

  - name: type
    message: Component type?
    type: select
    choices:
      - page
      - component
      - layout

files:
  - template: ".tsx.hbs"
    destination: "src/components//.tsx"

  - template: ".test.tsx.hbs"
    destination: "src/components//.test.tsx"
    condition: ""
```

## Template-Doc Linking

Templates can reference docs and vice versa:

**In `_template.yaml`:**
```yaml
doc: patterns/react-component
```

**In doc (markdown):**
```markdown
Use @template/react-component to generate.
```

**AI workflow:**
1. Get template config
2. Follow `doc:` link to understand patterns
3. Run template with appropriate variables

## Handlebars Helpers

Templates use Handlebars with built-in helpers:

| Helper | Example | Output |
|--------|---------|--------|
| `camelCase` | `myName` | `myName` |
| `pascalCase` | `MyName` | `MyName` |
| `kebabCase` | `my-name` | `my-name` |
| `snakeCase` | `my_name` | `my_name` |
| `upperCase` | `NAME` | `NAME` |
| `lowerCase` | `name` | `name` |

## CRITICAL: Template Syntax Pitfalls

### JavaScript Template Literals + Handlebars

**NEVER write `$` followed by triple-brace** - Handlebars interprets triple-brace as unescaped output:

```
// ❌ WRONG - Parse error!
this.logger.log(`Created: $` + `{{\{camelCase entity}.id}`);

// ✅ CORRECT - Add space, use ~ to trim whitespace
this.logger.log(`Created: ${ {{~camelCase entity~}}.id}`);
// Output: this.logger.log(`Created: ${product.id}`);
```

**Rules when writing .hbs templates:**
1. Never `$` + triple-brace - always add space: `${ {{`
2. Use `~` (tilde) to trim whitespace: `{{~helper~}}`
3. For literal braces, escape with backslash

## When to Use Templates

| Scenario | Action |
|----------|--------|
| Creating new component | Run `react-component` template |
| Adding API endpoint | Run `api-endpoint` template |
| Setting up new feature | Run `feature-module` template |
| Consistent file structure | Use template instead of copy-paste |

## Integrated Workflows

### During Implementation (Use Template)

```
Task → Read Context → Find Template → Generate Code → Customize
```

1. Read task and understand requirements
2. List templates to find applicable one
3. Get template details and read linked doc
4. Run template (dry run first, then real)
5. Customize generated code as needed
6. Continue with remaining implementation

**Benefits:**
- Reduces context (no need to generate boilerplate)
- Ensures consistency with project patterns
- Faster implementation

### During Extract (Create Template)

```
Context → Identify Pattern → Create Doc → Create Template → Link Both
```

1. Identify repeatable code pattern
2. Create doc with `/knowns.extract`
3. Create template with `knowns template create <name>`
4. Link template to doc: `doc: patterns/<name>`
5. Link doc to template: `@template/<name>`

**When to create template:**
- Pattern will be used multiple times
- Has consistent file structure
- Can be parameterized

## Checklist

- [ ] Listed available templates
- [ ] Got template details (prompts, files)
- [ ] Read linked documentation (if any)
- [ ] Understood required variables
- [ ] Ran dry run first
- [ ] Ran template with correct inputs
- [ ] Verified generated files

## Remember

- Always dry run first before writing files
- Check `doc:` link in template for context
- Templates ensure consistent code structure
- Create new templates for repeated patterns
- **NEVER write `$` + triple-brace** - use `${ {{~helper~}}` instead (add space, use tilde)