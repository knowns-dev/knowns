---
name: kn-extract
description: Use when extracting reusable patterns, solutions, or knowledge into documentation
---

# Extracting Knowledge

**Announce:** "Using kn-extract to extract knowledge."

**Core principle:** ONLY EXTRACT GENERALIZABLE KNOWLEDGE.

## Step 1: Identify Source

```json
mcp__knowns__get_task({ "taskId": "$ARGUMENTS" })
```

Look for: patterns, problems solved, decisions made, lessons learned.

## Step 2: Search for Existing Docs

```json
mcp__knowns__search_docs({ "query": "<pattern/topic>" })
```

**Don't duplicate.** Update existing docs when possible.

## Step 3: Create Documentation

```json
mcp__knowns__create_doc({
  "title": "Pattern: <Name>",
  "description": "Reusable pattern for <purpose>",
  "tags": ["pattern", "<domain>"],
  "folder": "patterns"
})

mcp__knowns__update_doc({
  "path": "patterns/<name>",
  "content": "# Pattern: <Name>\n\n## Problem\n...\n\n## Solution\n...\n\n## Example\n```typescript\n// Code\n```\n\n## Source\n@task-<id>"
})
```

## Step 4: Create Template (if code-generatable)

```json
mcp__knowns__create_template({
  "name": "<pattern-name>",
  "description": "Generate <what>",
  "doc": "patterns/<pattern-name>"
})
```

Link template in doc:
```json
mcp__knowns__update_doc({
  "path": "patterns/<name>",
  "appendContent": "\n\n## Generate\n\nUse @template/<pattern-name>"
})
```

## Step 5: Validate

**CRITICAL:** After creating doc/template, validate to catch broken refs:

```json
mcp__knowns__validate({})
```

If errors found, fix before continuing.

## Step 6: Link Back to Task

```json
mcp__knowns__update_task({
  "taskId": "$ARGUMENTS",
  "appendNotes": "📚 Extracted to @doc/patterns/<name>"
})
```

## What to Extract

| Source | Extract As | Template? |
|--------|------------|-----------|
| Code pattern | Pattern doc | ✅ Yes |
| API pattern | Integration guide | ✅ Yes |
| Error solution | Troubleshooting | ❌ No |
| Security approach | Guidelines | ❌ No |

## Checklist

- [ ] Knowledge is generalizable
- [ ] Includes working example
- [ ] Links back to source
- [ ] Template created (if applicable)
- [ ] **Validated (no broken refs)**
