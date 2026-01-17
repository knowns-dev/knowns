---
name: knowns.task.extract
description: Use when extracting reusable patterns, solutions, or knowledge from completed tasks into documentation
---

# Extracting Knowledge from Tasks

Convert task-specific implementations into reusable project documentation.

**Announce at start:** "I'm using the knowns.task.extract skill to extract knowledge from task [ID]."

**Core principle:** ONLY EXTRACT GENERALIZABLE KNOWLEDGE.

## The Process

### Step 1: Review Completed Task

```bash
knowns task $ARGUMENTS --plain
```

Look for:
- Implementation patterns used
- Problems solved
- Decisions made
- Lessons learned

### Step 2: Identify Extractable Knowledge

**Good candidates for extraction:**
- Reusable code patterns
- Error handling approaches
- Integration patterns
- Performance solutions
- Security practices
- API design decisions

**NOT good for extraction:**
- Task-specific details
- One-time fixes
- Context-dependent solutions

### Step 3: Search for Existing Docs

```bash
# Check if pattern already documented
knowns search "<pattern/topic>" --type doc --plain

# List related docs
knowns doc list --tag pattern --plain
```

**Don't duplicate.** Update existing docs when possible.

### Step 4: Create or Update Documentation

**If new pattern - create doc:**

```bash
knowns doc create "Pattern: <Name>" \
  -d "Reusable pattern for <purpose>" \
  -t "pattern,<domain>" \
  -f "patterns"
```

**Add content:**

```bash
knowns doc edit "patterns/<name>" -c "$(cat <<'EOF'
# Pattern: <Name>

## 1. Problem
What problem this pattern solves.

## 2. Solution
How to implement the pattern.

## 3. Example
```typescript
// Code example from the task
```

## 4. When to Use
- Situation 1
- Situation 2

## 5. Source
Discovered in @task-<id>
EOF
)"
```

**If updating existing doc:**

```bash
knowns doc edit "<path>" -a "

## Additional: <Topic>

From @task-<id>: <new insight or example>
"
```

### Step 5: Link Back to Task

```bash
knowns task edit $ARGUMENTS --append-notes "📚 Extracted to @doc/patterns/<name>"
```

## What to Extract

| From Task | Extract As |
|-----------|------------|
| New code pattern | Pattern doc |
| Error solution | Troubleshooting guide |
| API integration | Integration guide |
| Performance fix | Performance patterns |
| Security approach | Security guidelines |

## Document Templates

### Pattern Template
```markdown
# Pattern: <Name>

## Problem
What this solves.

## Solution
How to implement.

## Example
Working code.

## When to Use
When to apply this pattern.
```

### Guide Template
```markdown
# Guide: <Topic>

## Overview
What this covers.

## Steps
1. Step one
2. Step two

## Common Issues
- Issue and solution
```

## Quality Checklist

- [ ] Knowledge is generalizable (not task-specific)
- [ ] Includes working example
- [ ] Explains when to use
- [ ] Links back to source task
- [ ] Tagged appropriately

## Remember

- Only extract generalizable knowledge
- Search before creating (avoid duplicates)
- Include practical examples
- Reference source task
- Tag docs for discoverability
