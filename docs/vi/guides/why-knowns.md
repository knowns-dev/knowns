# Vì sao có Knowns?

Software work hiện đại có hai vấn đề lớn về context.

Thứ nhất, project knowledge bị phân tán. Task nằm một nơi, architecture notes nằm nơi khác, decision nằm trong chat, convention nằm trong trí nhớ của một người, còn implementation detail nằm trong code. Con người đôi khi tự ráp lại được context đó, nhưng AI assistant rất dễ mất context nếu mỗi session không bắt đầu bằng một đoạn giải thích dài.

Thứ hai, AI workflow cần nhiều hơn raw chat. Một assistant hữu ích cần biết task hiện tại, doc liên quan, memory bền vững, decision đã accepted, project rules, và cách verify work. Nếu thiếu cấu trúc này, assistant có thể trả lời rất tự tin nhưng lại làm việc từ context thiếu hoặc cũ.

Knowns tồn tại để làm project context trở nên rõ ràng, local, và dùng được cho cả người lẫn AI agent.

## Ý tưởng chính

Knowns là repo-local context layer. Nó kết nối task, doc, memory, template, search, MCP tools, và agent skills quanh cùng một project state.

Điều đó có nghĩa là:

- task định nghĩa work cần thay đổi
- doc giải thích vì sao project hoạt động theo cách hiện tại
- memory giữ context ngắn có thể dùng lại và convention
- search / retrieval tìm context liên quan mà không cần paste mọi thứ vào chat
- MCP expose structured tools cho AI assistant
- skill định nghĩa workflow lặp lại như spec, implementation, review, và verification

Mục tiêu không phải làm AI "nhớ mọi thứ". Mục tiêu là cho người và AI một shared operating layer có thể inspect, update, validate, và trust cẩn thận hơn.

## Vì sao repo-local?

Project context thay đổi cùng code. Giữ nó gần repository giúp:

- onboard người mới hoặc assistant mới
- tránh giải thích lại cùng context trong từng chat
- gắn implementation work với acceptance criteria
- giữ decision và convention sau khi conversation kết thúc
- validate generated project artifacts vẫn khớp config

Knowns cũng hỗ trợ user-level setup khi phù hợp. Ví dụ, `knowns setup codex --global` cài user-level MCP config, skills, và runtime hooks để assistant integration đi theo bạn qua nhiều repository.

## Vì sao dùng MCP `initial` và `help`?

Agent bootstrap nên dễ thay đổi mà không cần rewrite file trong từng repository. Knowns đặt runtime-critical guidance trong MCP `initial` và on-demand `help`, còn repo instruction files chỉ là lightweight compatibility shims cho tool auto-detect filename.

Startup path vì vậy nhỏ gọn hơn:

1. assistant gọi MCP `initial`
2. assistant dùng `help("tool.*")` hoặc `help("workflow.*")` khi cần chi tiết
3. assistant chỉ đọc task, doc, memory, hoặc code context cần cho work hiện tại

## Knowns không phải là gì?

Knowns không thay thế source code, tests, hoặc human review.

Memory chỉ là supplemental context. Nó không được override source-of-truth docs, tasks, source files, tests, hoặc explicit user instructions. Knowns giúp surface context và workflow state, nhưng correctness vẫn đến từ việc đọc code, chạy verification, và review changes.

## Kết quả thực tế

Với Knowns, project có thể chuyển từ:

```text
"Đây là một chat history rất dài. Hãy tự suy ra phần nào quan trọng."
```

sang:

```text
"Start with MCP initial, inspect task và doc, retrieve context liên quan, implement, review, và validate."
```

Đó là lý do Knowns tồn tại: ít phải lặp lại context hơn, workflow state dễ inspect hơn, và collaboration giữa người với AI agent an toàn hơn.
