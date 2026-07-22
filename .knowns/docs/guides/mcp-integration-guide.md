---
title: MCP Integration Guide
description: Setup MCP server for AI assistants (Claude, Cursor, etc.)
createdAt: '2026-02-24T08:45:15.876Z'
updatedAt: '2026-07-22T04:43:55.205Z'
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

Knowns is a compiled Go binary. Install it first, then configure MCP.

### Installation

```bash
# Via npm (downloads platform-specific Go binary)
npm install -g knowns

# Via Go
go install github.com/howznguyen/knowns/cmd/knowns@latest

# Via curl (Linux/macOS)
curl -fsSL https://raw.githubusercontent.com/howznguyen/knowns/main/install/install.sh | sh
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "knowns": {
      "command": "knowns",
      "args": ["mcp"]
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
      "command": "knowns",
      "args": ["mcp"]
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
      "command": "knowns",
      "args": ["mcp"]
    }
  }
}
```

> **Note**: If you don't have `knowns` installed globally, you can use `npx -y knowns mcp` as the command instead.
## Available MCP Tools

Tools are grouped by domain. Each tool uses an `action` parameter to dispatch operations.

```mermaid
graph TD
    subgraph "tasks tool"
        A1[create]
        A2[get]
        A3[update]
        A4[list]
        A5[board]
    end
    subgraph "docs tool"
        B1[create]
        B2[get]
        B3[update]
        B4[list]
    end
    subgraph "Other tools"
        C1[search]
        C2[validate]
        C3[templates]
        C4[time]
        C5[memory]
    end
```

### Task Tool (`tasks`)
- `create` - Create new task
- `get` - Get task by ID
- `update` - Update task fields (status, AC, plan, notes)
- `list` - List with filters
- `board` - Get kanban board state

### Doc Tool (`docs`)
- `create` - Create document
- `get` - Get doc (supports smart, section, toc)
- `update` - Update doc/section
- `list` - List with filters

### Other Tools
- `search` - Unified search (tasks + docs + memories) with semantic support
- `validate` - Check broken refs
- `templates` - List, get, run, create templates
- `time` - Start, stop, add, report time tracking
- `memory` - Add, get, list, update, delete, promote, demote memories

## Session Init

AI agents should start with:

```json
mcp__knowns__project({ "action": "detect" })
mcp__knowns__project({ "action": "set", "projectRoot": "/path/to/project" })
```

## Tips

1. Use `smart: true` for docs (auto-handles large files)
2. Follow refs returned in task/doc content
3. Validate after making changes
4. Use section editing for large docs


## Task Lifecycle MCP operations

The `tasks` tool supports `archive`, `unarchive`, `batch_archive`, `batch_unarchive`, and separately permission-gated `hard_delete`. Lifecycle mutations preview by default; set `execute: true` only after reviewing reasons and warnings. Hard Delete also requires `confirmed: true` and a non-empty `reason`.

Use `includeHistorical: true` with `search` or `retrieve` to include historical Tasks. Lifecycle event delivery is AT-LEAST-ONCE, so consumers must deduplicate using stable `Event.ID`. See @doc/features/task-lifecycle.
