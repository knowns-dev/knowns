# Workflow

Cách làm việc đề xuất khi kết hợp người và AI với Knowns.

Mục tiêu là giữ planning, context, implementation notes, và validation ở ngoài một chat session đơn lẻ. Người có thể điều khiển workflow từ CLI hoặc Web UI; AI assistant có thể dùng cùng context đó qua MCP tools và skills.

## Vòng lặp đề xuất cho mọi project

1. `knowns init` một lần cho mỗi project
2. Tạo task và doc hỗ trợ
3. AI bắt đầu bằng MCP `initial`, rồi dùng `help`, task, doc, memory khi cần
4. Implement
5. Validate
6. Sync khi cần

Vòng lặp này vẫn hữu ích kể cả khi không dùng AI assistant. AI integration chỉ làm cho cùng project state đó khả dụng với assistant.

## Lệnh hay đi cùng nhau

```bash
knowns task create "..."
knowns doc create "..."
knowns search "..." --plain
knowns retrieve "..." --json
knowns validate --plain
knowns sync
```

## Workflow do người điều khiển

Dùng cách này khi muốn Knowns làm project organization layer:

1. Tạo task với acceptance criteria.
2. Thêm doc cho architecture, decision, hoặc onboarding context.
3. Search trước khi bắt đầu để biết context nào đã có.
4. Update task notes trong lúc work tiến triển.
5. Chạy validation trước khi đánh dấu task done.

## Workflow có AI hỗ trợ

Dùng cách này khi assistant hỗ trợ planning hoặc implementation:

1. Chạy `knowns setup <target> --global` cho assistant platform.
2. Yêu cầu assistant inspect project state trước.
3. Cho assistant làm việc từ task, doc, hoặc spec thay vì prompt mơ hồ.
4. Dùng MCP tools cho structured reads/writes khi có.
5. Dùng skill cho agent-side workflow như spec, implementation, review, verification, hoặc flow orchestration.

Dùng `--global` cho personal assistant setup vì nó update user-level MCP config, skills, và runtime hooks. Chỉ dùng setup không có `--global` khi bạn chủ ý muốn repo-local integration files. Skill command prefix phụ thuộc assistant surface. Claude dùng `/kn-*`; Codex dùng `$kn-*`.

## Tại sao cách này hiệu quả?

- Task define mục tiêu
- Doc giải thích cấu trúc và intent
- Memory giữ lại decision và convention
- Retrieval nối tất cả lại cho cả người và AI

## Khi nào dùng gì

- **CLI**: thao tác nhanh, scripting, CI-friendly validation, và project maintenance trực tiếp
- **MCP**: structured AI integration cho task, doc, memory, search, template, code navigation, và validation
- **Web UI**: board, doc, graph, config, và chat workflows
- **Skill**: assistant-side workflow commands, ví dụ tạo spec, review, hoặc orchestration bằng `kn-flow`

## Kết thúc work

Trước khi xem work là xong:

```bash
knowns validate --plain
knowns sync
```

Validation kiểm tra project integrity. Sync giữ generated shim files và platform artifacts khớp với Knowns config hiện tại.
