---
title: MCP Integration Guide
createdAt: '2026-02-24T08:45:15.876Z'
updatedAt: '2026-02-24T08:49:57.709Z'
description: 'Setup MCP server for AI assistants (Claude, Cursor, etc.)'
tags:
  - guide
  - mcp
  - ai
  - integration
---
# MCP Integration Guide

Setup Knowns MCP server for AI assistants. Full docs: `./docs/mcp-integration.md`

## Architecture

```mermaid
graph LR
    A[AI Assistant] --> B[MCP Protocol]
    B --> C[Knowns MCP Server]
    C --> D[Tasks]
    C --> E[Docs]
    C --> F[Templates]
```

## Quick Setup

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "knowns": {
      "command": "npx",
      "args": ["knowns", "mcp"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "knowns": {
      "command": "npx",
      "args": ["knowns", "mcp"]
    }
  }
}
```

### Project-Specific (.mcp.json)

Create `.mcp.json` in project root:

```json
{
  "mcpServers": {
    "knowns": {
      "command": "npx",
      "args": ["knowns", "mcp"]
    }
  }
}
```

## Available MCP Tools

```mermaid
graph TD
    subgraph Tasks
        A1[create_task]
        A2[get_task]
        A3[update_task]
        A4[list_tasks]
    end
    subgraph Docs
        B1[create_doc]
        B2[get_doc]
        B3[update_doc]
        B4[list_docs]
    end
    subgraph Other
        C1[search]
        C2[validate]
        C3[run_template]
        C4[start_time / stop_time]
    end
```

### Task Tools
- `create_task` - Create new task
- `get_task` - Get task by ID
- `update_task` - Update task fields
- `list_tasks` - List with filters
- `search_tasks` - Search tasks

### Doc Tools
- `create_doc` - Create document
- `get_doc` - Get doc (supports smart, section, toc)
- `update_doc` - Update doc/section
- `list_docs` - List with filters
- `search_docs` - Search docs

### Other Tools
- `search` - Unified search (tasks + docs)
- `validate` - Check broken refs
- `list_templates` / `run_template` - Templates
- `start_time` / `stop_time` - Time tracking
- `get_board` - Kanban board state

## Session Init

AI agents should start with:

```json
mcp__knowns__detect_projects({})
mcp__knowns__set_project({ "projectRoot": "/path/to/project" })
```

## Tips

1. Use `smart: true` for docs (auto-handles large files)
2. Follow refs returned in task/doc content
3. Validate after making changes
4. Use section editing for large docs
