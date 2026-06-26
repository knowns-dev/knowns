# Web UI

Knowns có Web UI cho người muốn xem project context trực quan thay vì chỉ đọc CLI output. Web UI đọc cùng project state với CLI và MCP server, nên task, doc, memory, graph views, config, và chat workflows vẫn nối với nhau.

## Mở

```bash
knowns browser
knowns browser --open
```

Chạy command từ một Knowns project. Dùng `--open` khi muốn Knowns start local server và tự mở default browser.

## Các khu vực chính

- **Board và task views**: xem active work, status, priority, acceptance criteria, và notes.
- **Doc browser**: đọc project docs mà không cần nhớ CLI path.
- **Graph / knowledge views**: explore quan hệ giữa task, doc, memory, và references.
- **Config pages**: kiểm tra project settings, search setup, code intelligence, và integration state.
- **Chat page**: dùng chat-driven workflows khi Web UI phù hợp hơn terminal.

## Khi nào nên dùng

- Xem task theo kiểu board
- Duyệt doc tiện hơn CLI
- Explore graph hoặc dùng chat-driven workflows
- Onboard người mới cần hiểu project trước khi dùng CLI commands

## Liên quan tới AI setup

Web UI không thay thế MCP `initial` và `help`. Nó là human-facing view của cùng context. AI assistant vẫn nên bắt đầu bằng MCP `initial`, dùng `help` cho workflow/tool details, và chỉ dùng Web UI khi con người muốn inspect hoặc edit context trực quan.
