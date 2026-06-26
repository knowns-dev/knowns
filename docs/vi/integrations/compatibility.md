# Tương thích

Giải thích các compatibility behaviors mà Knowns giữ lại khi platform integrations hoặc generated artifact layouts thay đổi.

## Tại sao cần

Knowns quản lý nhiều loại generated files:

- skills directories
- MCP config files
- instruction files
- runtime hooks

Khi integrations thay đổi, project cũ có thể còn layout trước đây. Knowns giữ safe compatibility thay vì break ngay.

## Skills directory

Mapping chính:

- `.claude/skills` → Claude Code
- `.agents/skills` → OpenCode, Codex, Antigravity, Generic Agents
- `.kiro/skills` → Kiro

### Legacy

Path `.agent/skills` đã bị xóa. Tất cả agent-compatible platforms giờ dùng `.agents/skills`.

## MCP config

Knowns quản lý project-local MCP config:

- Claude Code → `.mcp.json`
- Kiro → `.kiro/settings/mcp.json`
- Cursor → `.cursor/mcp.json`
- Codex → `.codex/config.toml`
- OpenCode → `opencode.json`

Antigravity dùng global config:

- `~/.gemini/antigravity/mcp_config.json`

## Init, setup, sync, update

### `knowns init`

Tạo project structure, git tracking, semantic search setup, và selected lightweight project instruction shims như `CLAUDE.md` và `AGENTS.md`.

### `knowns setup`

Tạo AI platform artifacts như skills, MCP configs, platform-specific configs, runtime hooks, và instruction files bổ sung cho target được chọn. Dùng `knowns setup <target> --global` cho personal assistant setup thông thường. Chỉ dùng setup không có `--global` khi bạn chủ ý muốn repo-local integration files. Dùng `knowns setup agents` khi chỉ cần lightweight repo-local agent shims.

### `knowns sync`

Re-apply `.knowns/config.json` lên máy hiện tại.

Dùng sau khi:

- clone repo
- muốn generated files khớp lại với config

### `knowns update`

Update CLI, rồi refresh generated artifacts phụ thuộc vào binary hoặc config policy.

## Khuyến nghị

- Project mới → follow layout chính hiện tại
- Project cũ → để `knowns sync` và `knowns update` giữ tương thích trước, migrate có chủ đích sau
