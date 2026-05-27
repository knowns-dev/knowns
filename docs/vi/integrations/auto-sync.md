# Auto sync

Knowns dùng `knowns sync` và `knowns update` để giữ generated artifacts đồng bộ với binary và project config.

## Sync được gì

- instruction files
- skills
- MCP config
- platform-specific config
- git integration
- semantic setup và indexing

## Lệnh

```bash
knowns sync
knowns sync --skills
knowns sync --instructions
knowns update
```

## Legacy

Path `.agent/skills` đã bị xóa. Tất cả agent-compatible platforms giờ dùng `.agents/skills`.
