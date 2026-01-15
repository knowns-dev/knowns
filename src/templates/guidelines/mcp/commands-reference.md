# MCP Tools Reference

## mcp**knowns**create_task

Create a new task.

```json
{
  "title": "Task title",
  "description": "Task description",
  "status": "todo",
  "priority": "medium",
  "labels": ["label1", "label2"],
  "assignee": "@me",
  "parent": "parent-task-id"
}
```

| Parameter     | Required | Description                             |
| ------------- | -------- | --------------------------------------- |
| `title`       | Yes      | Task title                              |
| `description` | No       | Task description                        |
| `status`      | No       | todo/in-progress/in-review/blocked/done |
| `priority`    | No       | low/medium/high                         |
| `labels`      | No       | Array of labels                         |
| `assignee`    | No       | Assignee (use @me for self)             |
| `parent`      | No       | Parent task ID for subtasks             |

**Note:** Acceptance criteria must be added via `mcp__knowns__update_task` after creation.

---

## mcp**knowns**update_task

Update task fields.

```json
{
  "taskId": "abc123",
  "title": "New title",
  "description": "New description",
  "status": "in-progress",
  "priority": "high",
  "labels": ["updated"],
  "assignee": "@me"
}
```

| Parameter     | Required | Description       |
| ------------- | -------- | ----------------- |
| `taskId`      | Yes      | Task ID to update |
| `title`       | No       | New title         |
| `description` | No       | New description   |
| `status`      | No       | New status        |
| `priority`    | No       | New priority      |
| `labels`      | No       | New labels array  |
| `assignee`    | No       | New assignee      |

**Note:** For acceptance criteria, implementation plan, and notes - use CLI commands or edit task file directly through knowns CLI.

---

## mcp**knowns**get_task

Get a task by ID.

```json
{
  "taskId": "abc123"
}
```

---

## mcp**knowns**list_tasks

List tasks with optional filters.

```json
{
  "status": "in-progress",
  "priority": "high",
  "assignee": "@me",
  "label": "bug"
}
```

All parameters are optional filters.

---

## mcp**knowns**search_tasks

Search tasks by query string.

```json
{
  "query": "authentication"
}
```

---

## mcp**knowns**get_doc

Get a documentation file by path.

```json
{
  "path": "README"
}
```

Path can be filename or folder/filename (without .md extension).

### Large Documents (info, toc, section)

For large documents, check size first with `info`, then use `toc` and `section`:

```json
// Step 1: Check document size and token count
{
  "path": "readme",
  "info": true
}
// Response: { stats: { chars: 42461, estimatedTokens: 12132, headingCount: 83 }, recommendation: "..." }

// Step 2: Get table of contents
{
  "path": "readme",
  "toc": true
}

// Step 3: Read specific section by title or number
{
  "path": "readme",
  "section": "5. Sync"
}
```

| Parameter | Description                                              |
| --------- | -------------------------------------------------------- |
| `info`    | Set `true` to get stats (size, tokens, headings) only    |
| `toc`     | Set `true` to get table of contents only                 |
| `section` | Section title or number to read (e.g., "5. Sync" or "3") |

**Decision flow:**

- `info: true` → Check estimatedTokens → If >2000, use toc/section
- `toc: true` → Get heading list → Choose section to read
- `section: "X"` → Read only what you need

---

## mcp**knowns**list_docs

List all documentation files.

```json
{
  "tag": "api"
}
```

Optional `tag` parameter to filter by tag.

---

## mcp**knowns**create_doc

Create a new documentation file.

```json
{
  "title": "Doc Title",
  "description": "Doc description",
  "tags": ["tag1", "tag2"],
  "folder": "guides",
  "content": "Initial content"
}
```

### Document Structure Best Practice

When creating/updating docs, use clear heading structure for `toc` and `section` to work properly:

```markdown
# Main Title (H1 - only one)

## 1. Overview

Brief introduction...

## 2. Installation

Step-by-step guide...

## 3. Configuration

### 3.1 Basic Config

...

### 3.2 Advanced Config

...

## 4. API Reference

...
```

**Writing rules:**

- Use numbered headings (`## 1. Overview`) for easy `section: "1"` access
- Keep H1 for title only, use H2 for main sections
- Use H3 for subsections within H2
- Each section should be self-contained (readable without context)

**Reading workflow:**

```json
// Step 1: Check size first
{ "path": "<path>", "info": true }
// → If estimatedTokens <2000: read directly (no options)
// → If estimatedTokens >2000: continue to step 2

// Step 2: Get table of contents
{ "path": "<path>", "toc": true }

// Step 3: Read specific section
{ "path": "<path>", "section": "2" }
```

---

## mcp**knowns**update_doc

Update an existing documentation file.

```json
{
  "path": "README",
  "title": "New Title",
  "description": "New description",
  "tags": ["new", "tags"],
  "content": "Replace content",
  "appendContent": "Append to existing"
}
```

Use either `content` (replace) or `appendContent` (append), not both.

### Section Edit (Context-Efficient)

Replace only a specific section instead of entire document:

```json
// Step 1: View TOC to find section
{ "path": "readme", "toc": true }

// Step 2: Edit only that section
{
  "path": "readme",
  "section": "2. Installation",
  "content": "New content here..."
}
```

This reduces context usage significantly - no need to read/write entire document.

---

## mcp**knowns**search_docs

Search documentation by query.

```json
{
  "query": "authentication",
  "tag": "api"
}
```

---

## mcp**knowns**start_time

Start time tracking for a task.

```json
{
  "taskId": "abc123"
}
```

---

## mcp**knowns**stop_time

Stop time tracking.

```json
{
  "taskId": "abc123"
}
```

---

## mcp**knowns**add_time

Manually add a time entry.

```json
{
  "taskId": "abc123",
  "duration": "2h30m",
  "note": "Optional note",
  "date": "2025-01-15"
}
```

---

## mcp**knowns**get_time_report

Get time tracking report.

```json
{
  "from": "2025-01-01",
  "to": "2025-01-31",
  "groupBy": "task"
}
```

`groupBy` can be: task, label, or status.

---

## mcp**knowns**get_board

Get current board state with tasks grouped by status.

```json
{}
```

No parameters required.
