---
name: knowns.doc
description: Use when working with Knowns documentation - viewing, searching, creating, or updating docs
---

# Working with Documentation

Navigate, create, and update Knowns project documentation.

**Announce at start:** "I'm using the knowns.doc skill to work with documentation."

**Core principle:** SEARCH BEFORE CREATING - avoid duplicates.

## Quick Reference

```json
// List all docs
mcp__knowns__list_docs({})

// View doc (smart mode)
mcp__knowns__get_doc({ "path": "<path>", "smart": true })

// Search docs
mcp__knowns__search_docs({ "query": "<query>" })

// Create doc
mcp__knowns__create_doc({
  "title": "<title>",
  "description": "<description>",
  "tags": ["tag1", "tag2"],
  "folder": "folder"
})

// Update doc
mcp__knowns__update_doc({
  "path": "<path>",
  "content": "content"
})

// Update section only
mcp__knowns__update_doc({
  "path": "<path>",
  "section": "2",
  "content": "new section content"
})
```

## Reading Documents

**Use smart mode:**
```json
mcp__knowns__get_doc({ "path": "<path>", "smart": true })
```

- Small doc (≤2000 tokens) → full content
- Large doc → stats + TOC, then request specific section

## Creating Documents

### Step 1: Search First

```json
mcp__knowns__search_docs({ "query": "<topic>" })
```

**Don't duplicate.** Update existing docs when possible.

### Step 2: Choose Location

| Doc Type | Location | Folder |
|----------|----------|--------|
| Core (README, ARCH) | Root | (none) |
| Guide | `guides/` | `guides` |
| Pattern | `patterns/` | `patterns` |
| API doc | `api/` | `api` |

### Step 3: Create

```json
mcp__knowns__create_doc({
  "title": "<title>",
  "description": "<brief description>",
  "tags": ["tag1", "tag2"],
  "folder": "folder"
})
```

### Step 4: Add Content

```json
mcp__knowns__update_doc({
  "path": "<path>",
  "content": "# Title\n\n## 1. Overview\nWhat this doc covers.\n\n## 2. Details\nMain content."
})
```

## Updating Documents

### View First

```json
mcp__knowns__get_doc({ "path": "<path>", "smart": true })
mcp__knowns__get_doc({ "path": "<path>", "toc": true })
```

### Update Methods

| Method | Use When |
|--------|----------|
| Replace all | Rewriting entire doc |
| Append | Adding to end |
| Section edit | Updating one section |

**Section edit is most efficient** - less context, safer.

```json
// Update just section 3
mcp__knowns__update_doc({
  "path": "<path>",
  "section": "3",
  "content": "## 3. New Content\n\nUpdated section content..."
})
```

## Document Structure

Use numbered headings for section editing to work:

```markdown
# Title (H1 - only one)

## 1. Overview
...

## 2. Installation
...

## 3. Configuration
...
```

## Remember

- Search before creating (avoid duplicates)
- Use smart mode when reading
- Use section editing for targeted updates
- Use numbered headings
- Reference docs with `@doc/<path>`