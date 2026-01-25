---
name: knowns.doc
description: Use when working with Knowns documentation - viewing, searching, creating, or updating docs
---

# Working with Documentation

Navigate, create, and update Knowns project documentation.

**Announce at start:** "I'm using the knowns.doc skill to work with documentation."

**Core principle:** SEARCH BEFORE CREATING - avoid duplicates.

## Quick Reference

{{#if mcp}}
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
{{else}}
```bash
# List all docs
knowns doc list --plain

# View doc (auto-handles large docs)
knowns doc "<path>" --plain

# Search docs
knowns search "<query>" --type doc --plain

# Create doc
knowns doc create "<title>" -d "<description>" -t "tags" -f "folder"

# Update doc
knowns doc edit "<path>" -c "content"      # Replace
knowns doc edit "<path>" -a "content"      # Append
knowns doc edit "<path>" --section "2" -c "content"  # Section only
```
{{/if}}

## Reading Documents

{{#if mcp}}
**Use smart mode:**
```json
mcp__knowns__get_doc({ "path": "<path>", "smart": true })
```

- Small doc (≤2000 tokens) → full content
- Large doc → stats + TOC, then request specific section
{{else}}
**View doc:**
```bash
knowns doc "<path>" --plain
```

For large docs, use sections:
```bash
knowns doc "<path>" --toc --plain
knowns doc "<path>" --section "2" --plain
```
{{/if}}

## Creating Documents

### Step 1: Search First

{{#if mcp}}
```json
mcp__knowns__search_docs({ "query": "<topic>" })
```
{{else}}
```bash
knowns search "<topic>" --type doc --plain
```
{{/if}}

**Don't duplicate.** Update existing docs when possible.

### Step 2: Choose Location

| Doc Type | Location | Folder |
|----------|----------|--------|
| Core (README, ARCH) | Root | (none) |
| Guide | `guides/` | `guides` |
| Pattern | `patterns/` | `patterns` |
| API doc | `api/` | `api` |

### Step 3: Create

{{#if mcp}}
```json
mcp__knowns__create_doc({
  "title": "<title>",
  "description": "<brief description>",
  "tags": ["tag1", "tag2"],
  "folder": "folder"
})
```
{{else}}
```bash
knowns doc create "<title>" \
  -d "<brief description>" \
  -t "tag1,tag2" \
  -f "folder"  # optional
```
{{/if}}

### Step 4: Add Content

{{#if mcp}}
```json
mcp__knowns__update_doc({
  "path": "<path>",
  "content": "# Title\n\n## 1. Overview\nWhat this doc covers.\n\n## 2. Details\nMain content."
})
```
{{else}}
```bash
knowns doc edit "<path>" -c "$(cat <<'EOF'
# Title

## 1. Overview
What this doc covers.

## 2. Details
Main content.

## 3. Examples
Practical examples.
EOF
)"
```
{{/if}}

## Updating Documents

### View First

{{#if mcp}}
```json
mcp__knowns__get_doc({ "path": "<path>", "smart": true })
mcp__knowns__get_doc({ "path": "<path>", "toc": true })
```
{{else}}
```bash
knowns doc "<path>" --plain
knowns doc "<path>" --toc --plain  # For large docs
```
{{/if}}

### Update Methods

| Method | Use When |
|--------|----------|
| Replace all | Rewriting entire doc |
| Append | Adding to end |
| Section edit | Updating one section |

**Section edit is most efficient** - less context, safer.

{{#if mcp}}
```json
// Update just section 3
mcp__knowns__update_doc({
  "path": "<path>",
  "section": "3",
  "content": "## 3. New Content\n\nUpdated section content..."
})
```
{{else}}
```bash
# Update just section 3
knowns doc edit "<path>" --section "3" -c "## 3. New Content

Updated section content..."
```
{{/if}}

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
