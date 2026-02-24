---
title: Web UI Guide
createdAt: '2026-02-24T08:45:16.503Z'
updatedAt: '2026-02-24T08:45:16.503Z'
description: Using the Knowns Web UI - Kanban board and doc browser
tags:
  - guide
  - webui
  - kanban
  - browser
---
# Web UI Guide

Visual interface for tasks and docs. Full docs: `./docs/web-ui.md`

## Launch

```bash
knowns browser
# Opens http://localhost:6420
```

With custom port:
```bash
knowns browser --port 8080
```

## Features

### Kanban Board (`/kanban`)
- Drag-drop tasks between columns
- Click task to view/edit details
- Filter by label, assignee, priority
- Real-time sync with CLI

### Doc Browser (`/docs`)
- Browse documentation tree
- Markdown preview with mermaid diagrams
- Edit docs inline
- Create new docs

### Dashboard (`/`)
- Task summary by status
- Recent activity
- Quick actions

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `n` | New task |
| `/` | Search |
| `Esc` | Close modal |

## Real-time Sync

Web UI syncs automatically when:
- CLI creates/updates tasks
- CLI creates/updates docs
- Another browser tab makes changes

Uses Server-Sent Events (SSE) for instant updates.

## Mermaid Diagrams

Docs support mermaid rendering:

````markdown
```mermaid
graph TD
    A[Start] --> B{Decision}
    B -->|Yes| C[Done]
```
````

## Tips

1. **Use alongside CLI** - Both stay in sync
2. **Kanban for overview** - See all tasks at once
3. **Doc browser for reading** - Better than terminal
4. **Keep browser open** - Real-time updates
