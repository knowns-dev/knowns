# Tài liệu Knowns

Knowns là một project context layer cho software team và AI agent. Nó gom task, doc, memory, template, semantic search, và AI integrations vào cùng một repo-local system để người và AI cùng làm việc trên một nguồn context thống nhất.

Dùng bộ docs này khi bạn muốn:

- setup Knowns trong một repository có sẵn
- giữ project work, decision, và doc ở nơi cả người lẫn AI đều đọc được
- kết nối assistant qua MCP, skill, hoặc lightweight shim files
- dùng Web UI để xem board, doc, graph, và chat workflows

Nội dung tiếng Việt bám theo `docs/en/` nhưng viết lại cho dễ đọc với developer Việt. Các feature name như task, doc, memory, template, search, MCP, skill, Web UI được giữ nguyên để khớp với CLI và UI.

## Khái niệm chính

- **Task**: phần work đã được lên kế hoạch, có status, acceptance criteria, notes, và context links.
- **Doc**: project knowledge bền vững như architecture, spec, decision, hoặc onboarding.
- **Memory**: context ngắn, có thể dùng lại về sau, ví dụ convention hoặc preference.
- **Template**: scaffolding có thể tái sử dụng cho code hoặc doc pattern lặp lại.
- **Search / retrieval**: cách tìm context local từ task, doc, memory, và code references.
- **MCP và skill**: bề mặt tích hợp AI. MCP expose structured tools; skill là workflow command phía agent, ví dụ `/kn-*` trong Claude hoặc `$kn-*` trong Codex.

## Bắt đầu từ đâu?

1. [Cài đặt](./getting-started/installation.md)
2. [Quick start](./getting-started/quick-start.md)
3. [Dự án đầu tiên](./getting-started/first-project.md)
4. [Vì sao có Knowns?](./guides/why-knowns.md)
5. [Hướng dẫn sử dụng](./guides/user-guide.md)
6. [Quản lý task](./guides/task-management.md)
7. [Làm việc với AI](./guides/ai-agent-guide.md)
8. [AI workflow](./guides/ai-workflow.md)

## Nên đọc trang nào trước?

- Người mới: đọc [Cài đặt](./getting-started/installation.md), rồi [Quick start](./getting-started/quick-start.md).
- Project owner: đọc [Dự án đầu tiên](./getting-started/first-project.md), rồi [Workflow](./guides/workflow.md).
- Người dùng AI assistant: đọc [AI workflow](./guides/ai-workflow.md), [MCP](./guides/mcp-integration.md), và [Skills](./integrations/skills.md).
- Muốn tra cứu CLI: vào thẳng [Lệnh](./reference/commands.md).

## Cấu trúc

- `getting-started/` — cài đặt và chạy lần đầu
- `guides/` — hướng dẫn theo tình huống thực tế
- `reference/` — tra cứu lệnh, config, cơ chế tham chiếu
- `integrations/` — platform, MCP, skills, templates, sync, tương thích
- `contributing/` — cho người muốn đóng góp

## Mục lục

### Bắt đầu

- [Cài đặt](./getting-started/installation.md)
- [Quick start](./getting-started/quick-start.md)
- [Dự án đầu tiên](./getting-started/first-project.md)

### Hướng dẫn

- [Vì sao có Knowns?](./guides/why-knowns.md)
- [Hướng dẫn sử dụng](./guides/user-guide.md)
- [Quản lý task](./guides/task-management.md)
- [Làm việc với AI](./guides/ai-agent-guide.md)
- [AI workflow](./guides/ai-workflow.md)
- [Memory](./guides/memory-system.md)
- [Workflow](./guides/workflow.md)
- [Web UI](./guides/web-ui.md)
- [MCP](./guides/mcp-integration.md)

### Tra cứu

- [Lệnh](./reference/commands.md)
- [Cấu hình](./reference/configuration.md)
- [Sync](./reference/sync.md)
- [Validate](./reference/validate.md)
- [Quản lý model](./reference/model-management.md)
- [Reference system](./reference/reference-system.md)
- [Semantic search](./reference/semantic-search.md)

### Tích hợp

- [Platforms](./integrations/platforms.md)
- [Skills](./integrations/skills.md)
- [Templates](./integrations/templates.md)
- [Auto sync](./integrations/auto-sync.md)
- [Tương thích](./integrations/compatibility.md)
- [Guidance files](./integrations/guidance-files.md)

### Đóng góp

- [Developer guide](./contributing/developer-guide.md)
