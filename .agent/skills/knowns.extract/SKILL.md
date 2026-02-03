---
name: knowns.extract
description: Use when extracting reusable patterns, solutions, or knowledge into documentation
---

# Extracting Knowledge

Convert implementations, patterns, or solutions into reusable project documentation.

**Announce at start:** "I'm using the knowns.extract skill to extract knowledge."

**Core principle:** ONLY EXTRACT GENERALIZABLE KNOWLEDGE.

## The Process

### Step 1: Identify Source

**From task (if ID provided):**
```json
mcp__knowns__get_task({ "taskId": "$ARGUMENTS" })
```

**From current context (no arguments):**
- Recent implementation work
- Patterns discovered during research
- Solutions found in conversation

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

```json
// Check if pattern already documented
mcp__knowns__search_docs({ "query": "<pattern/topic>" })

// List related docs
mcp__knowns__list_docs({ "tag": "pattern" })
```

**Don't duplicate.** Update existing docs when possible.

### Step 4: Create or Update Documentation

**If new pattern - create doc:**

```json
mcp__knowns__create_doc({
  "title": "Pattern: <Name>",
  "description": "Reusable pattern for <purpose>",
  "tags": ["pattern", "<domain>"],
  "folder": "patterns"
})
```

**Add content:**

```json
mcp__knowns__update_doc({
  "path": "patterns/<name>",
  "content": "# Pattern: <Name>\n\n## 1. Problem\nWhat problem this pattern solves.\n\n## 2. Solution\nHow to implement the pattern.\n\n## 3. Example\n```typescript\n// Code example\n```\n\n## 4. When to Use\n- Situation 1\n\n## 5. Source\nDiscovered in @task-<id>"
})
```

**If updating existing doc:**

```json
mcp__knowns__update_doc({
  "path": "<path>",
  "appendContent": "\n\n## Additional: <Topic>\n\n<new insight or example>"
})
```

### Step 5: Create Template (if code-generatable)

If the pattern involves repeatable code structure, create a codegen template:

```bash
# Create template skeleton
knowns template create <pattern-name>
```

**Update template config** (`.knowns/templates/<pattern-name>/_template.yaml`):

```yaml
name: <pattern-name>
description: Generate <what it creates>
doc: patterns/<pattern-name>    # Link to the doc you just created

prompts:
  - name: name
    message: Name?
    validate: required

files:
  - template: ".ts.hbs"
    destination: "src/.ts"
```

**Create template files** (`.hbs` files with Handlebars):

```handlebars
// .ts.hbs
export class  {
  // Pattern implementation
}
```

**Link template in doc:**

```json
mcp__knowns__update_doc({
  "path": "patterns/<name>",
  "appendContent": "\n\n## Generate\n\nUse @template/<pattern-name> to generate this pattern."
})
```

### Step 6: Link Back (if from task)

```bash
knowns task edit $ARGUMENTS --append-notes "📚 Extracted to @doc/patterns/<name>"
knowns task edit $ARGUMENTS --append-notes "🔧 Template: @template/<pattern-name>"
```

## What to Extract

| Source | Extract As | Create Template? |
|--------|------------|------------------|
| Code pattern | Pattern doc | ✅ Yes |
| Component structure | Pattern doc | ✅ Yes |
| API endpoint pattern | Integration guide | ✅ Yes |
| Error solution | Troubleshooting guide | ❌ No |
| Performance fix | Performance patterns | ❌ Usually no |
| Security approach | Security guidelines | ❌ No |

**Create template when:**
- Pattern is repeatable (will be used multiple times)
- Has consistent file structure
- Can be parameterized (name, type, etc.)

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
- [ ] Links back to source (if applicable)
- [ ] Tagged appropriately
- [ ] Template created (if code-generatable)
- [ ] Doc links to template (`@template/...`)
- [ ] Template links to doc (`doc:` in config)

## Remember

- Only extract generalizable knowledge
- Search before creating (avoid duplicates)
- Include practical examples
- Reference source when available
- Tag docs for discoverability
- **Create template for repeatable code patterns**
- **Link doc ↔ template bidirectionally**