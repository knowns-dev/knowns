---
name: kn-template
description: Use when generating code from templates - list, run, or create templates
---

# Working with Templates

**Announce:** "Using kn-template to work with templates."

**Core principle:** USE TEMPLATES FOR CONSISTENT CODE GENERATION.

## Inputs

- Template name or generation goal
- Variables required by prompts
- Linked pattern doc, if one exists

## Preflight

- Read the linked doc before running a non-trivial template
- Use dry run before generating real files
- Check whether a template already exists before creating a new one

## Step 1: List Templates

```json
mcp_knowns_templates({ "action": "list" })
```

## Step 2: Get Template Details

```json
mcp_knowns_templates({ "action": "get", "name": "<template-name>" })
```

Check: prompts, `doc:` link, files to generate.

## Step 3: Read Linked Documentation

```json
mcp_knowns_docs({ "action": "get", "path": "<doc-path>", "smart": true })
```

## Step 4: Run Template

```json
// Dry run first
mcp_knowns_templates({ "action": "run", "name": "<template-name>",
  "variables": { "name": "MyComponent" },
  "dryRun": true
})

// Then run for real
mcp_knowns_templates({ "action": "run", "name": "<template-name>",
  "variables": { "name": "MyComponent" },
  "dryRun": false
})
```

## Step 5: Create New Template

```json
mcp_knowns_templates({ "action": "create", "name": "<template-name>",
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

## Step 6: Validate (after creating template)

```json
mcp_knowns_validate({ "scope": "templates" })
```

## Shared Output Contract

All built-in skills in scope must end with the same user-facing information order: `kn-init`, `kn-spec`, `kn-flow`, `kn-plan`, `kn-research`, `kn-implement`, `kn-verify`, `kn-doc`, `kn-template`, `kn-extract`, and `kn-commit`.

Required order for the final user-facing response:

1. Goal/result - state what template was inspected, created, or run.
2. Key details - include the most important supporting context, refs, files, warnings, or validation.
3. Next action - recommend a concrete follow-up command only when a natural handoff exists.

Keep this concise for CLI use. Template-specific content may extend the key-details section, but must not replace or reorder the shared structure.

Out of scope: explaining, syncing, or generating `.claude/skills/*`. Runtime auto-sync already handles platform copies, so this skill source only defines the built-in output contract.

For `kn-template`, the key details should cover:

- which template was inspected, created, or run
- dry-run vs real execution
- generated or modified files
- any missing prompt values, doc gaps, or syntax issues

When template work naturally leads to implementation or review, include the best next command. If the user only inspected templates or finished with a dry run decision, do not force a handoff.

## Failure Modes

- Missing linked doc -> say so and inspect the template directly
- Dry run looks wrong -> stop and fix the template before real generation
- New template overlaps an existing one -> prefer update or consolidation

## Checklist

- [ ] Listed available templates
- [ ] Read linked documentation
- [ ] Ran dry run first
- [ ] Verified generated files
- [ ] **Validated (if created new template)**
