# Sync

`knowns sync` re-apply `.knowns/config.json` lên máy hiện tại.

## Khi nào dùng

Chạy `knowns sync` sau khi:

- clone repo có sẵn `.knowns/`
- upgrade CLI
- muốn generated files khớp lại với config

Để cấu hình AI platforms (skills, instructions, MCP configs), dùng `knowns setup`.

## Các dạng dùng

```bash
knowns sync
knowns sync --skills
knowns sync --instructions
knowns sync --model
knowns sync --instructions --platform claude
knowns sync --instructions --platform cursor
```

## Refresh được gì

- skills
- instruction files
- MCP config
- platform-specific config
- git integration
- semantic-search setup
- search indexes

## Xem thêm

- [Cấu hình](./configuration.md)
- [Tương thích](../integrations/compatibility.md)
- [Auto sync](../integrations/auto-sync.md)
