---
title: Validate Command
createdAt: '2026-02-03T15:32:39.328Z'
updatedAt: '2026-02-03T16:22:02.528Z'
description: >-
  Spec for knowns validate command - checks task/doc/template references and
  quality
tags:
  - feature
  - spec
  - validate
  - cli
---
# Validate Command

Validates tasks, docs, and templates for quality and reference integrity.

## 1. Overview

Unlike OpenSpec which validates spec format/structure, Knowns validation focuses on:

- **Reference integrity** - Do `@task-`, `@doc/`, `@template/` refs resolve?
- **Task quality** - Has AC? Has description? 
- **Doc health** - Orphan docs? Stale references?
- **Template validity** - Can templates be resolved?

This leverages Knowns' unique reference system to catch errors *before* AI starts coding.

## 2. CLI Usage

```bash
# Basic validation (all entities)
knowns validate

# Validate specific type
knowns validate --type task
knowns validate --type doc
knowns validate --type template

# Strict mode (warnings become errors)
knowns validate --strict

# JSON output (for CI/CD)
knowns validate --json

# Fix auto-fixable issues
knowns validate --fix
```

## 3. Validation Rules

### 3.1 Task Validation

| Rule | Severity | Description |
|------|----------|-------------|
| `task-no-ac` | warning | Task has no acceptance criteria |
| `task-no-description` | warning | Task has no description |
| `task-broken-doc-ref` | error | `@doc/x` reference doesn't resolve |
| `task-broken-task-ref` | error | `@task-x` reference doesn't resolve |
| `task-broken-template-ref` | error | `@template/x` reference doesn't resolve |
| `task-self-ref` | warning | Task references itself |
| `task-circular-parent` | error | Circular parent-child relationship |

### 3.2 Doc Validation

| Rule | Severity | Description |
|------|----------|-------------|
| `doc-orphan` | info | No tasks reference this doc |
| `doc-broken-doc-ref` | error | `@doc/x` in content doesn't resolve |
| `doc-broken-task-ref` | error | `@task-x` in content doesn't resolve |
| `doc-broken-template-ref` | error | `@template/x` in content doesn't resolve |
| `doc-empty` | warning | Doc has no content |
| `doc-no-description` | info | Doc has no description |

### 3.3 Template Validation

| Rule | Severity | Description |
|------|----------|-------------|
| `template-broken-doc-ref` | error | Linked doc doesn't exist |
| `template-missing-files` | error | `.hbs` files referenced in config missing |
| `template-invalid-config` | error | `_template.yaml` has syntax errors |
| `template-no-prompts` | warning | Template has no prompts defined |

## 4. Output Format

### 4.1 Human-Readable (default)

```
knowns validate

Validating...

Tasks (15 total)
  ✅ 12 valid
  ⚠️  2 warnings
  ❌ 1 error

  ❌ task-42: @doc/old-pattern not found (doc was renamed)
     → Did you mean: @doc/auth-v2 ?
  
  ⚠️  task-45: Missing acceptance criteria
  ⚠️  task-48: Missing description

Docs (9 total)
  ✅ 7 valid
  ℹ️  2 info

  ℹ️  docs/payment-flow: Orphan doc — no tasks reference this
  ℹ️  docs/legacy-api: Orphan doc — no tasks reference this

Templates (3 total)
  ✅ 3 valid

Summary: 1 error, 2 warnings, 2 info
```

### 4.2 JSON Output

```json
{
  "valid": false,
  "summary": {
    "tasks": { "total": 15, "valid": 12, "errors": 1, "warnings": 2 },
    "docs": { "total": 9, "valid": 7, "info": 2 },
    "templates": { "total": 3, "valid": 3 }
  },
  "issues": [
    {
      "type": "task",
      "id": "task-42",
      "rule": "task-broken-doc-ref",
      "severity": "error",
      "message": "@doc/old-pattern not found",
      "suggestion": "@doc/auth-v2",
      "location": { "field": "description", "line": 3 }
    }
  ]
}
```

## 5. Auto-Fix Support

Some issues can be auto-fixed with `--fix`:

| Rule | Fix Action |
|------|------------|
| `task-broken-doc-ref` | Suggest rename if similar doc found |
| `doc-broken-task-ref` | Remove reference if task deleted |
| `doc-orphan` | No auto-fix (informational only) |

```bash
knowns validate --fix

Fixed 2 issues:
  ✓ task-42: Updated @doc/old-pattern → @doc/auth-v2
  ✓ docs/api-guide: Removed stale @task-99 reference
```

## 6. CI/CD Integration

```bash
# In CI pipeline - exit code reflects validity
knowns validate --strict
echo $?  # 0 = valid, 1 = errors found

# Generate report
knowns validate --json > validation-report.json
```

### 6.1 GitHub Actions Example

```yaml
- name: Validate Knowns
  run: |
    knowns validate --strict --json > validation.json
    if [ $? -ne 0 ]; then
      echo "::error::Knowns validation failed"
      cat validation.json
      exit 1
    fi
```

## 7. Configuration

Optional `.knowns/config.json` settings:

```json
{
  "validate": {
    "rules": {
      "doc-orphan": "off",
      "task-no-description": "error"
    },
    "ignore": [
      "docs/drafts/**",
      "task-999"
    ]
  }
}
```

## 8. Why This Matters

| Without Validation | With Validation |
|--------------------|-----------------|
| AI reads `@doc/auth-pattern`, not found → codes blindly | Catches broken ref before AI starts |
| Renamed doc, 10 tasks still reference old name | Single command finds all stale refs |
| Orphan docs accumulate, clutter grows | Identify unused docs for cleanup |
| CI passes but knowledge graph is broken | CI catches integrity issues |

## 9. Implementation Notes

- Validation should be fast (< 2s for 100 tasks + 50 docs)
- Cache parsed references for performance
- Support incremental validation (only changed files)
- Reference resolution uses same logic as CLI display

## 10. Related

- @doc/architecture/patterns/storage - How refs are stored
- @doc/features/import-system - Imported refs need validation too



## 11. MCP Tool

Validate is also available as MCP tool for AI agents:

```json
mcp__knowns__validate({
  "type": "task",     // optional: "task" | "doc" | "template"
  "strict": false,    // optional: treat warnings as errors
  "fix": false        // optional: auto-fix broken refs
})
```

**Returns:**
```json
{
  "success": true,
  "valid": true,
  "stats": { "tasks": 48, "docs": 38, "templates": 2 },
  "summary": { "errors": 0, "warnings": 2, "info": 5 },
  "issues": [...],
  "fixes": [...]  // if fix=true
}
```

See @doc/ai/mcp for full MCP documentation.
