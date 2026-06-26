# Guidance files

Knowns dùng lightweight compatibility files cho AI runtimes có cơ chế auto-detect repository instruction files. Các file này chỉ nên là entrypoint nhỏ, yêu cầu assistant bắt đầu bằng Knowns MCP `initial` và dùng on-demand `help` để xem tool schemas và workflow guidance.

Runtime-critical guidance nằm trong MCP `initial` và `help`, không nằm trong một repository prompt file lớn. Cách này giúp Knowns update agent behavior mà không bắt mọi repository phải đổi generated markdown.

## Compatibility files

- `CLAUDE.md`
- `OPENCODE.md`
- `GEMINI.md`
- `AGENTS.md`
- `.github/copilot-instructions.md`

## Refresh

```bash
knowns init
knowns setup agents
knowns setup --global
knowns sync
knowns sync --instructions
```

Dùng `knowns init` để tạo project state ban đầu và selected lightweight shims. Dùng `knowns setup agents` để tạo hoặc refresh generic repo-local shims, `knowns setup <target> --global` cho personal platform integrations thông thường, hoặc `knowns sync` để refresh generated files từ config.

## Agent bootstrap

Khi bắt đầu session, assistant nên:

1. gọi MCP `initial`
2. dùng `help("tool.*")` hoặc `help("workflow.*")` khi cần chi tiết
3. chỉ dùng CLI command làm fallback khi MCP không khả dụng
