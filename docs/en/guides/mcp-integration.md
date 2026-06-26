# MCP Integration

Knowns exposes an MCP server so AI assistants can access tasks, docs, memory, decisions, templates, time tracking, search, validation, project state, help, and code tools directly.

## Server command

```bash
knowns mcp --stdio
knowns mcp --stdio --project /path/to/project
```

If `--project` is not set, Knowns attempts to auto-detect the project from the current working directory.

## Current platform support

| Platform | Config file | Scope | Auto setup |
|---|---|---|---|
| Claude Code | `.mcp.json` | per-project | yes |
| Kiro | `.kiro/settings/mcp.json` | per-project | yes |
| OpenCode | `opencode.json` | per-project | yes |
| Codex | `.codex/config.toml` | per-project | yes |
| Cursor | `.cursor/mcp.json` | per-project | yes |
| Antigravity | `~/.gemini/antigravity/mcp_config.json` | global | yes |
| Claude Desktop | app config | global | manual |

## Typical config examples

### Claude Code

```json
{
  "mcpServers": {
    "knowns": {
      "command": "knowns",
      "args": ["mcp", "--stdio"]
    }
  }
}
```

### Cursor

```json
{
  "mcpServers": {
    "knowns": {
      "command": "knowns",
      "args": ["mcp", "--stdio"]
    }
  }
}
```

### Codex

```toml
[mcp_servers.knowns]
command = "knowns"
args = ["mcp", "--stdio"]
```

### OpenCode

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "knowns": {
      "type": "local",
      "command": ["knowns", "mcp", "--stdio"],
      "enabled": true
    }
  }
}
```

## Important note for global MCP clients

For global MCP configs, the server may not know which project to use at session start if the client starts it outside your repo.

Prefer a project-aware server command when the client supports it:

```bash
knowns mcp --stdio --project /path/to/project
```

Or set the active project with the MCP `project` tool:

```json
{ "action": "detect" }
{ "action": "set", "projectRoot": "/path/to/project" }
{ "action": "current" }
```

## Session start

Call `initial` at the start of every session. It returns:

- project state (knowledge counts, active timer, LSP status)
- code intelligence rules (which tools to use for code operations)
- workflow guidance (tool orchestration patterns)
- available tools summary

No need to call `project({ action: "status" })` separately — `initial` covers it.

## On-demand help

Use `help` for detailed per-action documentation:

```json
{ "queries": ["code.find"] }
{ "queries": ["code.*"] }
{ "queries": ["insert"] }
```

Returns JSON structured as `{ tool: { action: { when, params, ... } } }`.

## Why MCP is useful

- structured AI access to project state
- less shell parsing and less prompt copy-paste
- easier validation and retrieval workflows for AI assistants
- `initial` + `help` minimize token overhead while maximizing agent context
