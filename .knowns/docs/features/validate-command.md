---
id: doc-9191fced2ced73494d9e78a45bf2585f
title: Validate Command
createdAt: '2026-02-03T15:32:39.328Z'
updatedAt: '2026-03-09T07:48:40.419Z'
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

Knowns validation focuses on:

- **Reference integrity** — Do task and doc references resolve?
- **Task quality** — Has title? Valid status/priority? Unchecked AC on done tasks?
- **Doc health** — Has title? Has description? Stale references?
- **Template validity** — Do `.hbs` files exist? Do they parse correctly?

This catches errors *before* AI starts coding.
## 2. CLI Usage

```bash
# Basic validation (all entities)
knowns validate

# Validate specific scope
knowns validate --scope tasks
knowns validate --scope docs
knowns validate --scope templates

# Validate specific entity (saves tokens for AI)
knowns validate --entity abc123        # single task
knowns validate --entity specs/auth    # single doc

# Strict mode (warnings become errors)
knowns validate --strict

# JSON output (for CI/CD)
knowns validate --json

# Fix auto-fixable issues
knowns validate --fix

# SDD (Spec-Driven Development) validation
knowns validate --scope sdd
```

### Flags

| Flag | Description |
|------|-------------|
| `--scope` | `all` (default), `tasks`, `docs`, `templates`, `sdd` |
| `--entity` | Validate a single entity by task ID or doc path |
| `--strict` | Treat warnings as errors |
| `--fix` | Auto-fix supported issues |
| `--json` | Output as JSON |
| `--plain` | Plain text output (for AI agents) |

## 3. Validation Rules

All rules are implemented in `internal/validate/validate.go` and shared between CLI and MCP.

### 3.1 Task Validation

| Code | Severity | Description |
|------|----------|-------------|
| `TASK_NO_TITLE` | error | Task has no title |
| `TASK_NO_STATUS` | warning | Task has no status |
| `TASK_INVALID_STATUS` | warning | Status not in standard list (todo, in-progress, in-review, done, blocked, on-hold, urgent) |
| `TASK_NO_PRIORITY` | info | Task has no priority |
| `TASK_INVALID_PRIORITY` | warning | Priority not in [low, medium, high] |
| `BROKEN_TASK_REF` | error | Parent task not found |
| `TASK_CIRCULAR_PARENT` | error | Circular parent chain detected (A→B→A) |
| `BROKEN_DOC_REF` | warning | Spec doc or inline doc reference not found |
| `TASK_FULFILLS_NO_SPEC` | warning | Task has `fulfills` but no linked spec |
| `TASK_DUPLICATE_LABELS` | info | Duplicate entries in labels array |
| `TASK_DONE_UNCHECKED_AC` | warning | Task is done but has unchecked acceptance criteria |
| `BROKEN_TASK_REF` | warning | Inline task reference in description/plan/notes not found |
| `SDD_NO_AC` | warning | Task linked to spec but has no AC (SDD scope only) |

### 3.2 Doc Validation

| Code | Severity | Description |
|------|----------|-------------|
| `DOC_PARSE_ERROR` | error | Failed to parse doc file |
| `DOC_NO_TITLE` | warning | Doc has no title |
| `DOC_NO_DESCRIPTION` | info | Doc has no description |
| `DOC_NO_CONTENT` | info | Doc has no content |
| `BROKEN_TASK_REF` | info | Inline task reference in content not found |
| `BROKEN_DOC_REF` | info | Inline doc reference in content not found |

### 3.3 Template Validation

| Code | Severity | Description |
|------|----------|-------------|
| `TEMPLATE_LIST_ERROR` | error | Failed to list templates |
| `TEMPLATE_NO_NAME` | error | Template has no name |
| `TEMPLATE_NO_ACTIONS` | warning | Template has no actions defined |
| `TEMPLATE_FILE_MISSING` | error | `.hbs` file referenced in action not found |
| `TEMPLATE_PARSE_ERROR` | error | `.hbs` file has Handlebars/Go template syntax errors |
| `TEMPLATE_PATH_ERROR` | error | Action path template has syntax errors |
| `BROKEN_DOC_REF` | warning | Linked doc not found |

## 4. Output Format

### 4.1 Human-Readable (default)

```
ERROR   [abc123] Parent task "xyz789" not found
WARN    [def456] Task is done but AC #1 is not checked: Add tests
INFO    [readme] Doc has no description

Summary: 1 error(s), 1 warning(s), 1 info
```

### 4.2 Plain Text (`--plain`)

```
ERROR [abc123] Parent task "xyz789" not found
WARNING [def456] Task is done but AC #1 is not checked: Add tests
INFO [readme] Doc has no description

SUMMARY: 1 errors, 1 warnings, 1 info
VALID: false
```

### 4.3 JSON Output (`--json`)

```json
{
  "issues": [
    {
      "level": "error",
      "code": "BROKEN_TASK_REF",
      "message": "Parent task \"xyz789\" not found",
      "entity": "abc123"
    }
  ],
  "errors": 1,
  "warnings": 1,
  "info": 1,
  "valid": false
}
```

## 5. Strict Mode

With `--strict`, all warnings are upgraded to errors. This is useful for CI/CD where you want zero tolerance:

```bash
knowns validate --strict
# A task with no status (normally warning) now causes exit code 1
```

## 6. CI/CD Integration

```bash
# In CI pipeline — exit code reflects validity
knowns validate --strict --json

# Generate report
knowns validate --json > validation-report.json
```

### GitHub Actions Example

```yaml
- name: Validate project
  run: knowns validate --strict
```

## 7. Implementation Notes

### Architecture

Validation logic is centralized in `internal/validate/validate.go`:

```
internal/validate/
├── validate.go          # Shared engine (Run, validateTask, validateDoc, validateTemplate)
└── validate_test.go     # 27 unit tests
```

Both CLI (`internal/cli/validate.go`) and MCP (`internal/mcp/handlers/validate.go`) call `validate.Run()` and only handle output formatting.

### Key types

```go
type Issue struct {
    Level   string  // "error", "warning", "info"
    Code    string  // e.g. "TASK_NO_TITLE"
    Message string  // human-readable description
    Entity  string  // task ID or doc path
    Fixed   bool    // true if auto-fixed
}

type Result struct {
    Issues       []Issue
    ErrorCount   int
    WarningCount int
    InfoCount    int
    Valid        bool  // true when ErrorCount == 0
}

type Options struct {
    Scope  string  // "all", "tasks", "docs", "templates", "sdd"
    Entity string  // filter to single entity
    Strict bool    // warnings → errors
    Fix    bool    // auto-fix supported issues
}
```

### Performance

- Loads all tasks and docs once, builds lookup maps for O(1) ref checks
- Circular parent detection uses visited-set walk (max depth = number of tasks)
- Template `.hbs` files are parsed but not executed during validation

## 8. MCP Tool

The same validation engine is available via MCP:

```json
mcp__knowns__validate({
  "scope": "all",
  "entity": "abc123",
  "strict": false,
  "fix": false
})
```

Returns JSON with `valid`, `issues`, `errorCount`, `warningCount`, `infoCount`, `summary`.

## 9. Related

- `internal/validate/validate.go` — shared validation engine
- `internal/cli/validate.go` — CLI output formatting
- `internal/mcp/handlers/validate.go` — MCP JSON response
