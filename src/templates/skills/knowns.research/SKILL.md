---
name: knowns.research
description: Use when you need to understand existing code, find patterns, or explore the codebase before implementation
---

# Researching the Codebase

Understand existing patterns and implementation before making changes.

**Announce at start:** "I'm using the knowns.research skill to research [topic]."

**Core principle:** UNDERSTAND WHAT EXISTS BEFORE ADDING NEW CODE.

## The Process

### Step 1: Search Documentation

```bash
# Search docs for topic
knowns search "<topic>" --type doc --plain

# Read relevant docs
knowns doc "<path>" --plain --smart
```

### Step 2: Search Completed Tasks

```bash
# Find similar work that was done
knowns search "<keywords>" --type task --status done --plain

# View task for implementation details
knowns task <id> --plain
```

**Learn from history** - completed tasks often contain valuable insights.

### Step 3: Search Codebase

```bash
# Find files by name pattern
find . -name "*<pattern>*" -type f | grep -v node_modules | head -20

# Search code content
grep -r "<pattern>" --include="*.ts" --include="*.tsx" -l | head -20
```

### Step 4: Analyze Patterns

Look for:
- How similar features are implemented
- Common patterns used
- File/folder structure conventions
- Naming conventions
- Error handling patterns

### Step 5: Document Findings

```markdown
## Research: [Topic]

### Existing Implementations
- `src/path/file.ts`: Does X
- `src/path/other.ts`: Handles Y

### Patterns Found
- Pattern 1: Used for...
- Pattern 2: Applied when...

### Related Docs
- @doc/path1 - Covers X
- @doc/path2 - Explains Y

### Recommendations
Based on research:
1. Reuse X from Y
2. Follow pattern Z
3. Avoid approach W because...
```

## Research Checklist

- [ ] Searched documentation
- [ ] Reviewed similar completed tasks
- [ ] Found existing code patterns
- [ ] Identified reusable components
- [ ] Noted conventions to follow

## After Research

Use findings in task:
```bash
# Create informed task
knowns task create "<title>" \
  -d "Based on research: use pattern from X" \
  --ac "Follow pattern in src/..." \
  --ac "Reuse component Y"

# Or update existing task plan
knowns task edit <id> --plan $'1. Based on research...
2. Reuse pattern from...'
```

## What to Look For

| Looking For | Where to Check |
|-------------|----------------|
| Conventions | @doc/CONVENTIONS, existing code |
| Patterns | @doc/patterns/*, similar features |
| Utilities | src/utils/*, src/lib/* |
| Examples | Completed tasks, tests |
| API design | Existing endpoints, @doc/api/* |

## When to Research

**Always research before:**
- Implementing new features
- Adding new patterns
- Making architectural decisions

**Skip research for:**
- Simple bug fixes with clear cause
- Trivial changes following obvious patterns

## Remember

- Check docs and tasks first
- Look at how similar things are done
- Note file locations for reference
- Look at tests for expected behavior
- Document findings for future reference
