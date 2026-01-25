---
title: MCP Configuration
createdAt: '2026-01-23T04:07:55.764Z'
updatedAt: '2026-01-23T04:12:34.599Z'
description: MCP server setup for all AI platforms
tags:
  - feature
  - ai
  - mcp
---
## Overview

MCP (Model Context Protocol) cho phép AI gọi trực tiếp Knowns functions.

**Related:** @doc/ai/platforms

---

## Support Matrix

| Platform | Config File | Auto-discover |
|----------|-------------|---------------|
| **Claude Code** | `.mcp.json` | ✅ |
| **Antigravity** | `.agent/settings.json` | ✅ |
| **Gemini CLI** | `~/.gemini/settings.json` | ✅ |
| **Cursor** | `.cursor/mcp.json` | ⚠️ Manual |
| **Cline** | `.cline/mcp.json` | ⚠️ Manual |
| **Continue** | `.continue/config.json` | ⚠️ Manual |

---

## Knowns MCP Server

```json
{
  "command": "npx",
  "args": ["-y", "knowns", "mcp"]
}
```

---

## Platform Configs

### Claude Code: `.mcp.json`
```json
{
  "mcpServers": {
    "knowns": {
      "command": "npx",
      "args": ["-y", "knowns", "mcp"]
    }
  }
}
```

### Antigravity: `.agent/settings.json`
```json
{
  "mcp": {
    "servers": {
      "knowns": {
        "command": "npx",
        "args": ["-y", "knowns", "mcp"]
      }
    }
  }
}
```

### Gemini CLI: `~/.gemini/settings.json`
```json
{
  "mcpServers": {
    "knowns": {
      "command": "npx",
      "args": ["-y", "knowns", "mcp"]
    }
  }
}
```

### Cursor: `.cursor/mcp.json`
```json
{
  "mcpServers": {
    "knowns": {
      "command": "npx",
      "args": ["-y", "knowns", "mcp"]
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
          "command": "npx",
          "args": ["-y", "knowns", "mcp"]
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
knowns mcp init --all
knowns mcp init --platform claude,cursor

# Check status
knowns mcp status
```

---

## Available MCP Tools

### Tasks
| Tool | Description |
|------|-------------|
| `mcp__knowns__list_tasks` | List tasks |
| `mcp__knowns__get_task` | Get task |
| `mcp__knowns__create_task` | Create task |
| `mcp__knowns__update_task` | Update task |

### Docs
| Tool | Description |
|------|-------------|
| `mcp__knowns__list_docs` | List docs |
| `mcp__knowns__get_doc` | Get doc |
| `mcp__knowns__create_doc` | Create doc |
| `mcp__knowns__update_doc` | Update doc |

### Time
| Tool | Description |
|------|-------------|
| `mcp__knowns__start_time` | Start timer |
| `mcp__knowns__stop_time` | Stop timer |

---

## MCP vs CLI

| Aspect | MCP | CLI |
|--------|-----|-----|
| Speed | Faster | Slower |
| Output | JSON | Text |
| Complex ops | Limited | Full |

**Recommendation:** MCP for reads, CLI for complex edits (--ac, --plan, --notes)


---

## Extended MCP Tools (Planned)

MCP sẽ hỗ trợ **tất cả features** của CLI, không cần fallback.

### Task Tools - Extended

| Tool | Parameters | CLI Equivalent |
|------|------------|----------------|
| `mcp__knowns__update_task` | `taskId`, `status`, `priority`, `assignee`, `labels` | `task edit -s/-p/-a/-l` |
| `mcp__knowns__add_acceptance_criteria` | `taskId`, `criterion` | `task edit --ac` |
| `mcp__knowns__check_acceptance_criteria` | `taskId`, `index` | `task edit --check-ac` |
| `mcp__knowns__uncheck_acceptance_criteria` | `taskId`, `index` | `task edit --uncheck-ac` |
| `mcp__knowns__set_plan` | `taskId`, `plan` | `task edit --plan` |
| `mcp__knowns__set_notes` | `taskId`, `notes` | `task edit --notes` |
| `mcp__knowns__append_notes` | `taskId`, `notes` | `task edit --append-notes` |

### Example: Full Task Workflow via MCP

```json
// 1. Get task
mcp__knowns__get_task({ "taskId": "abc123" })

// 2. Take task
mcp__knowns__update_task({
  "taskId": "abc123",
  "status": "in-progress",
  "assignee": "@me"
})

// 3. Start timer
mcp__knowns__start_time({ "taskId": "abc123" })

// 4. Add acceptance criteria
mcp__knowns__add_acceptance_criteria({
  "taskId": "abc123",
  "criterion": "User can login"
})

// 5. Set implementation plan
mcp__knowns__set_plan({
  "taskId": "abc123",
  "plan": "1. Research
2. Implement
3. Test"
})

// 6. Check AC after completing
mcp__knowns__check_acceptance_criteria({
  "taskId": "abc123",
  "index": 1
})

// 7. Append progress notes
mcp__knowns__append_notes({
  "taskId": "abc123",
  "notes": "✓ Completed: login feature"
})

// 8. Stop timer
mcp__knowns__stop_time({ "taskId": "abc123" })

// 9. Mark done
mcp__knowns__update_task({
  "taskId": "abc123",
  "status": "done"
})
```

### Doc Tools - Extended

| Tool | Parameters | CLI Equivalent |
|------|------------|----------------|
| `mcp__knowns__update_doc` | `path`, `content` | `doc edit -c` |
| `mcp__knowns__append_doc` | `path`, `content` | `doc edit -a` |
| `mcp__knowns__update_doc_section` | `path`, `section`, `content` | `doc edit --section` |

### Template Tools (Planned)

| Tool | Parameters | CLI Equivalent |
|------|------------|----------------|
| `mcp__knowns__list_templates` | - | `template list` |
| `mcp__knowns__get_template` | `name` | `template view` |
| `mcp__knowns__run_template` | `name`, `answers` | `template run` |

### Skill Tools (Planned)

| Tool | Parameters | CLI Equivalent |
|------|------------|----------------|
| `mcp__knowns__list_skills` | - | `skill list` |
| `mcp__knowns__sync_skills` | `platforms` | `skill sync` |

---

## Full Feature Parity

| Feature | CLI | MCP (Current) | MCP (Planned) |
|---------|-----|---------------|---------------|
| List tasks | ✅ | ✅ | ✅ |
| Get task | ✅ | ✅ | ✅ |
| Create task | ✅ | ✅ | ✅ |
| Update status | ✅ | ✅ | ✅ |
| **Add AC** | ✅ | ❌ | ✅ |
| **Check AC** | ✅ | ❌ | ✅ |
| **Set plan** | ✅ | ❌ | ✅ |
| **Set notes** | ✅ | ❌ | ✅ |
| **Append notes** | ✅ | ❌ | ✅ |
| Time tracking | ✅ | ✅ | ✅ |
| List docs | ✅ | ✅ | ✅ |
| Get doc | ✅ | ✅ | ✅ |
| Create doc | ✅ | ✅ | ✅ |
| Update doc | ✅ | ✅ | ✅ |
| Search | ✅ | ✅ | ✅ |
| **Templates** | ✅ | ❌ | ✅ |
| **Skills** | ✅ | ❌ | ✅ |
