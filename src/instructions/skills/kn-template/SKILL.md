---
name: kn-template
description: Use when generating code from templates - list, run, or create templates
---

# Working with Templates

**Announce:** "Using kn-template to work with templates."

**Core principle:** USE TEMPLATES FOR CONSISTENT CODE GENERATION.

## Step 1: List Templates

```json
mcp__knowns__list_templates({})
```

## Step 2: Get Template Details

```json
mcp__knowns__get_template({ "name": "<template-name>" })
```

Check: prompts, `doc:` link, files to generate.

## Step 3: Read Linked Documentation

```json
mcp__knowns__get_doc({ "path": "<doc-path>", "smart": true })
```

## Step 4: Run Template

```json
// Dry run first
mcp__knowns__run_template({
  "name": "<template-name>",
  "variables": { "name": "MyComponent" },
  "dryRun": true
})

// Then run for real
mcp__knowns__run_template({
  "name": "<template-name>",
  "variables": { "name": "MyComponent" },
  "dryRun": false
})
```

## Step 5: Create New Template

```json
mcp__knowns__create_template({
  "name": "<template-name>",
  "description": "Description",
  "doc": "patterns/<related-doc>"
})
```

## Template Config

```yaml
name: react-component
description: Create a React component
doc: patterns/react-component

prompts:
  - name: name
    message: Component name?
    validate: required

files:
  - template: ".tsx.hbs"
    destination: "src/components//.tsx"
```

## CRITICAL: Syntax Pitfalls

**NEVER write `$` + triple-brace:**
```
// ❌ WRONG
$` + `{` + `{` + `{camelCase name}`

// ✅ CORRECT - add space, use ~
${ {{~camelCase name~}}}
```

## Checklist

- [ ] Listed available templates
- [ ] Read linked documentation
- [ ] Ran dry run first
- [ ] Verified generated files
