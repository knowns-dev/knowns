---
name: kn-research
description: Use when you need to understand existing code, find patterns, or explore the codebase before implementation
---

# Researching the Codebase

**Announce:** "Using kn-research for [topic]."

**Core principle:** UNDERSTAND WHAT EXISTS BEFORE ADDING NEW CODE.

## Step 1: Search Documentation

```json
mcp__knowns__search_docs({ "query": "<topic>" })
mcp__knowns__get_doc({ "path": "<path>", "smart": true })
```

## Step 2: Search Completed Tasks

```json
mcp__knowns__search_tasks({ "query": "<keywords>" })
mcp__knowns__get_task({ "taskId": "<id>" })
```

## Step 3: Search Codebase

```bash
find . -name "*<pattern>*" -type f | grep -v node_modules | head -20
grep -r "<pattern>" --include="*.ts" -l | head -20
```

## Step 4: Document Findings

```markdown
## Research: [Topic]

### Existing Implementations
- `src/path/file.ts`: Does X

### Patterns Found
- Pattern 1: Used for...

### Related Docs
- @doc/path1 - Covers X

### Recommendations
1. Reuse X from Y
2. Follow pattern Z
```

## Checklist

- [ ] Searched documentation
- [ ] Reviewed similar completed tasks
- [ ] Found existing code patterns
- [ ] Identified reusable components

## Next Step

After research: `/kn-plan <task-id>`