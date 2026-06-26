# Làm việc với AI

Cách dùng Knowns hiệu quả khi làm việc cùng AI assistants.

## Ý chính

AI làm việc tốt hơn nhiều khi không phải tự đoán context.

Knowns cho AI truy cập có cấu trúc vào:

- task
- doc
- memory
- reference
- validation
- search và retrieval

## Cách dùng

### 1. Gọi `initial` trước

AI nên gọi tool `initial` khi bắt đầu session. Nó trả về project state, code intelligence rules, workflow guidance, và danh sách tools — đủ để bắt đầu làm việc.

### 2. Dùng `help` khi cần chi tiết

Khi AI cần dùng tool/action chưa quen, gọi `help("tool.action")` hoặc `help("tool.*")` để xem hướng dẫn on-demand.

### 3. Dùng task làm mục tiêu

Thay vì prompt mơ hồ, trỏ AI vào task có acceptance criteria rõ ràng.

### 3. Dùng doc cho context lâu dài

Architecture, pattern, hướng dẫn vận hành nên nằm trong doc, không chỉ tồn tại trong chat.

### 4. Dùng memory cho decision cần nhớ

Lưu decision, convention, failure vào memory để gọi lại sau.

### 5. Validate trước khi coi là xong

Validation nên là phần bình thường của workflow.

## Thứ tự nguồn khi research

Khi AI cần hiểu codebase hoặc upstream behavior, nên search theo thứ tự:

1. Knowns `search` và `retrieve` cho local project context.
2. Knowns `code` tools cho code structure, symbols, definitions, references, diagnostics, và edits.
3. External MCP providers như Context7/library docs, GitHub/source MCP, hoặc official docs MCP khi cần current upstream facts.
4. General web search khi specialized MCP providers không có, không đủ, hoặc user yêu cầu rõ.

External research nên có citation và phải reconcile với local source-of-truth files, không silently override chúng.

## MCP hay CLI?

### Ưu tiên MCP khi:

- AI runtime hỗ trợ MCP
- muốn structured tool calls
- muốn giảm parse shell output

### Ưu tiên CLI khi:

- MCP không có
- đang script ngoài MCP-aware runtime
- muốn xem output trực tiếp trong terminal

## Ví dụ workflow

1. AI gọi `initial` (nhận project state + rules + workflow guidance)
2. AI đọc target task
3. AI follow `@doc/...` hoặc `@task-...` references
4. AI gọi `help("tool.action")` nếu chưa rõ cách dùng tool
5. AI dùng `code` tools cho code discovery và editing (không dùng Read/Grep/Edit)
6. AI implement
7. AI chạy validation hoặc test

## Xem thêm

- [Quản lý task](./task-management.md)
- [MCP](./mcp-integration.md)
- [Workflow](./workflow.md)
