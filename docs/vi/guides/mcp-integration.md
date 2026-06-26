# MCP

Knowns expose MCP server để AI assistants truy cập trực tiếp task, doc, memory, decision, template, time tracking, search, validation, project state, help, và code tools.

## Server command

```bash
knowns mcp --stdio
knowns mcp --stdio --project /path/to/project
```

Nếu không truyền `--project`, Knowns sẽ cố auto-detect project từ current working directory.

## Platform support

| Platform | Config file | Scope | Auto setup |
|---|---|---|---|
| Claude Code | `.mcp.json` | per-project | yes |
| Kiro | `.kiro/settings/mcp.json` | per-project | yes |
| OpenCode | `opencode.json` | per-project | yes |
| Codex | `.codex/config.toml` | per-project | yes |
| Cursor | `.cursor/mcp.json` | per-project | yes |
| Antigravity | `~/.gemini/antigravity/mcp_config.json` | global | yes |
| Claude Desktop | app config | global | manual |

## Config ví dụ

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

## Lưu ý với global MCP clients

Với config MCP global, server có thể không biết project nào cần dùng nếu client start server ngoài repo.

Ưu tiên server command có project rõ ràng khi client hỗ trợ:

```bash
knowns mcp --stdio --project /path/to/project
```

Hoặc set active project bằng MCP `project` tool:

```json
{ "action": "detect" }
{ "action": "set", "projectRoot": "/path/to/project" }
{ "action": "current" }
```

## Bắt đầu session

Gọi `initial` khi bắt đầu mỗi session. Nó trả về:

- project state (số lượng knowledge, active timer, LSP status)
- code intelligence rules (dùng tool nào cho code operations)
- workflow guidance (cách phối hợp tools)
- danh sách tools có sẵn

Không cần gọi `project({ action: "status" })` riêng — `initial` đã bao gồm.

## Help on-demand

Dùng `help` để xem hướng dẫn chi tiết cho từng action:

```json
{ "queries": ["code.find"] }
{ "queries": ["code.*"] }
{ "queries": ["insert"] }
```

Trả về JSON dạng `{ tool: { action: { when, params, ... } } }`.

## Tại sao MCP hữu ích

- AI truy cập project state có cấu trúc
- Ít phải parse shell output
- Validation và retrieval workflows dễ hơn
- `initial` + `help` giảm token overhead, tăng context cho agent
