---
id: doc-6dcf538b7984e748efdf212bc6eb2b8b
title: MCP Configuration
description: MCP server setup — Claude Code and OpenCode supported, others for reference
createdAt: '2026-01-23T04:07:55.764Z'
updatedAt: '2026-04-02T09:27:44.662Z'
tags:
  - feature
  - ai
  - mcp
---

PATH: ai/mcp
TITLE: MCP Configuration
DESCRIPTION: MCP server setup — Claude Code and OpenCode supported, others for reference
TAGS: feature, ai, mcp
UPDATED: 2026-04-02

## Overview

MCP (Model Context Protocol) allows AI to call Knowns functions directly.

**Related:** @doc/ai/platforms

---

## Session Initialization (CRITICAL)

**CRITICAL: At the START of every MCP session, run these tools to set the project context:**

```json
// 1. Detect available projects
mcp__knowns__project({ "action": "detect" })

// 2. Set the active project
mcp__knowns__project({ "action": "set", "projectRoot": "/path/to/project" })

// 3. Verify project is set
mcp__knowns__project({ "action": "current" })
```

**Why?** MCP servers (especially global configs like Antigravity) don't know which project to work with. Without setting the project, operations will fail or affect the wrong directory.

---

## Support Matrix

| Platform | Config File | Auto-setup | Project Scope | Status |
|----------|-------------|------------|---------------|--------|
| **Claude Code** | `.mcp.json` (project) | ✅ `knowns init` | Per-project | **Supported** |
| **OpenCode** | `opencode.json` (project/global) | ✅ `knowns init` | Needs `project({ action: "set" })` | **Supported** |
| Gemini CLI | `~/.gemini/settings.json` (global) | — | Needs `project({ action: "set" })` | Reference |
| Antigravity | `~/.gemini/antigravity/mcp_config.json` (global) | — | Needs `project({ action: "set" })` | Reference |
| Cursor | `.cursor/mcp.json` (project) | — | Per-project | Reference |
| Cline | `.cline/mcp.json` (project) | — | Per-project | Reference |
| Continue | `.continue/config.json` (project) | — | Per-project | Reference |

See @doc/ai/platforms for full config examples.
## Knowns MCP Server

Knowns is a compiled Go binary. The MCP server is started with the `mcp` subcommand.

**If installed via npm, go install, or direct download:**
```json
{
  "command": "knowns",
  "args": ["mcp"]
}
```

**If using npx (no global install):**
```json
{
  "command": "npx",
  "args": ["-y", "knowns", "mcp"]
}
```

---
## Platform Configs

> **Note**: All examples below use `knowns mcp` directly (assumes `knowns` is installed globally via `npm install -g knowns`, `go install`, or direct binary download). Replace with `npx -y knowns mcp` if using npx without global install.

### Claude Code: `.mcp.json` (Project-level)
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

### Antigravity: `~/.gemini/antigravity/mcp_config.json` (Global)
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

> **Note**: Antigravity uses global config. Use `mcp__knowns__project({ action: "detect" })` and `mcp__knowns__project({ action: "set" })` at session start to set the correct project.

### Gemini CLI: `~/.gemini/settings.json` (Global)
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

### Cursor: `.cursor/mcp.json`
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

### Continue: `.continue/config.json`
```json
{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "name": "knowns",
        "transport": {
          "type": "stdio",
          "command": "knowns",
          "args": ["mcp"]
        }
      }
    ]
  }
}
```

---
## CLI Commands

```bash
# Auto-generate MCP config
knowns mcp setup
```

---

## Available MCP Tools

### Project Tools (Session Init)
| Tool | Action | Description |
|------|--------|-------------|
| `mcp__knowns__project` | `detect` | Scan for Knowns projects |
| `mcp__knowns__project` | `set` | Set active project |
| `mcp__knowns__project` | `current` | Get current project status |
| `mcp__knowns__project` | `status` | Check project readiness and capabilities |

### Tasks
| Tool | Action | Description |
|------|--------|-------------|
| `mcp__knowns__tasks` | `list` | List tasks |
| `mcp__knowns__tasks` | `get` | Get task |
| `mcp__knowns__tasks` | `create` | Create task |
| `mcp__knowns__tasks` | `update` | Update task (status, AC, plan, notes) |
| `mcp__knowns__tasks` | `delete` | Delete task (dry-run by default) |
| `mcp__knowns__tasks` | `history` | Get version history of a task |
| `mcp__knowns__tasks` | `board` | Get kanban board state |

### Docs
| Tool | Action | Description |
|------|--------|-------------|
| `mcp__knowns__docs` | `list` | List docs |
| `mcp__knowns__docs` | `get` | Get doc (with smart mode) |
| `mcp__knowns__docs` | `create` | Create doc |
| `mcp__knowns__docs` | `update` | Update doc |
| `mcp__knowns__docs` | `delete` | Delete doc (dry-run by default) |
| `mcp__knowns__docs` | `history` | Get version history of a doc |

### Memory (Persistent)
| Tool | Action | Description |
|------|--------|-------------|
| `mcp__knowns__memory` | `add` | Create a memory entry (project or global layer) |
| `mcp__knowns__memory` | `get` | Get memory entry by ID |
| `mcp__knowns__memory` | `list` | List memories with layer/category/tag filters |
| `mcp__knowns__search` | `search` (type: memory) | Search memory entries via unified search |
| `mcp__knowns__memory` | `update` | Update memory entry |
| `mcp__knowns__memory` | `delete` | Delete memory entry (dry-run by default) |
| `mcp__knowns__memory` | `promote` | Promote up one layer (project→global) |
| `mcp__knowns__memory` | `demote` | Demote down one layer (global→project) |

### Working Memory (Session-Scoped)
| Tool | Action | Description |
|------|--------|-------------|
| `mcp__knowns__working_memory` | `add` | Add ephemeral session memory |
| `mcp__knowns__working_memory` | `get` | Get working memory by ID |
| `mcp__knowns__working_memory` | `list` | List all session memories |
| `mcp__knowns__working_memory` | `delete` | Delete a working memory entry |
| `mcp__knowns__working_memory` | `clear` | Clear all session memories |

### Search
| Tool | Action | Description |
|------|--------|-------------|
| `mcp__knowns__search` | `search` | Unified search (tasks + docs + memories) with semantic support |
| `mcp__knowns__search` | `retrieve` | Ranked context retrieval with citations |
| `mcp__knowns__search` | `resolve` | Resolve semantic reference expression |

### Time
| Tool | Action | Description |
|------|--------|-------------|
| `mcp__knowns__time` | `start` | Start timer |
| `mcp__knowns__time` | `stop` | Stop timer |
| `mcp__knowns__time` | `add` | Add manual time entry |
| `mcp__knowns__time` | `report` | Get time report |

### Templates
| Tool | Action | Description |
|------|--------|-------------|
| `mcp__knowns__templates` | `list` | List templates |
| `mcp__knowns__templates` | `get` | Get template config |
| `mcp__knowns__templates` | `run` | Run template |
| `mcp__knowns__templates` | `create` | Create template scaffold |

### Validation
| Tool | Description |
|------|-------------|
| `mcp__knowns__validate` | Validate tasks, docs, templates, memories for broken refs and quality |

## MCP vs CLI

| Aspect | MCP | CLI |
|--------|-----|-----|
| Speed | Faster | Slower |
| Output | JSON | Text |
| Complex ops | ✅ Full support | ✅ Full support |

**Recommendation:** Use MCP for all operations when available.

---

## Full Feature Parity

| Feature | CLI | MCP |
|---------|-----|-----|
| List tasks | ✅ | ✅ |
| Get task | ✅ | ✅ |
| Create task | ✅ | ✅ |
| Update status | ✅ | ✅ |
| **Add AC** | ✅ | ✅ |
| **Check AC** | ✅ | ✅ |
| **Set plan** | ✅ | ✅ |
| **Set notes** | ✅ | ✅ |
| **Append notes** | ✅ | ✅ |
| Time tracking | ✅ | ✅ |
| List docs | ✅ | ✅ |
| Get doc | ✅ | ✅ |
| Create doc | ✅ | ✅ |
| Update doc | ✅ | ✅ |
| Search | ✅ | ✅ |
| Templates | ✅ | ✅ |
| **Validate** | ✅ | ✅ |
| **Memory (persistent)** | ✅ | ✅ |
| **Working memory** | ✅ | ✅ |
| **Promote/demote** | ✅ | ✅ |
| **Project detection** | N/A | ✅ |
## Example: Full Task Workflow via MCP

```json
// 0. Session init (required for global MCP configs)
mcp__knowns__project({ "action": "detect" })
mcp__knowns__project({ "action": "set", "projectRoot": "/path/to/project" })

// 1. Get task
mcp__knowns__tasks({ "action": "get", "taskId": "abc123" })

// 2. Take task
mcp__knowns__tasks({
  "action": "update",
  "taskId": "abc123",
  "status": "in-progress",
  "assignee": "@me"
})

// 3. Start timer
mcp__knowns__time({ "action": "start", "taskId": "abc123" })

// 4. Add acceptance criteria
mcp__knowns__tasks({
  "action": "update",
  "taskId": "abc123",
  "addAc": ["User can login"]
})

// 5. Set implementation plan
mcp__knowns__tasks({
  "action": "update",
  "taskId": "abc123",
  "plan": "1. Research\n2. Implement\n3. Test"
})

// 6. Check AC after completing
mcp__knowns__tasks({
  "action": "update",
  "taskId": "abc123",
  "checkAc": [1]
})

// 7. Append progress notes
mcp__knowns__tasks({
  "action": "update",
  "taskId": "abc123",
  "appendNotes": "✓ Completed: login feature"
})

// 8. Stop timer
mcp__knowns__time({ "action": "stop", "taskId": "abc123" })

// 9. Mark done
mcp__knowns__tasks({
  "action": "update",
  "taskId": "abc123",
  "status": "done"
})
```



---

## Example: Validate Before Planning

```json
// Check for broken refs before starting work
mcp__knowns__validate({})

// Returns:
{
  "success": true,
  "valid": true,  // or false if errors
  "stats": { "tasks": 48, "docs": 38, "templates": 2 },
  "summary": { "errors": 0, "warnings": 2, "info": 5 },
  "issues": [...]
}

// Validate specific type only
mcp__knowns__validate({ "type": "task" })

// Strict mode (warnings → errors)
mcp__knowns__validate({ "strict": true })

// Auto-fix broken refs
mcp__knowns__validate({ "fix": true })
```

**Use cases:**
- Before planning: check if refs in task description are valid
- After editing docs: verify no broken links introduced
- CI/CD integration: fail build if validation errors exist
