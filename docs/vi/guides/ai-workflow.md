# AI workflow

Chọn đúng flow cho loại việc sắp làm. Tất cả flow dưới đây giả định AI có thể dùng nhóm skill `kn-*` khi runtime hỗ trợ.

Skills không phải MCP tools. Skills là agent workflow commands được sync vào skills directory của từng agent. MCP tools sẽ hiện trong `codex mcp` dưới dạng domain tools như `tasks`, `docs`, `memory`, `search`, và `code`.

| Platform | Skill syntax |
|---|---|
| Claude Code | `/kn-spec`, `/kn-flow`, `/kn-review` |
| Codex | `$kn-spec`, `$kn-flow`, `$kn-review` |

Ví dụ bên dưới dùng syntax `/kn-*` của Claude Code. Với Codex, đổi `/` thành `$`.

Dùng tài liệu này khi cần quyết định: đi full spec-driven, task flow thường, hay quick fix.

## Chọn flow

| Flow | Khi nào | Trình tự |
|---|---|---|
| Full SDD | feature lớn, hệ thống mới, thay đổi cross-cutting | init → research → spec → flow → extract |
| Normal | feature nhỏ, cải tiến, task đã rõ | init → plan → implement |
| Quick Fix | bug fix, hotfix, sửa nhỏ | init → implement |

## Tại sao research trước spec?

AI cần đủ context trước khi viết spec để tránh draft sai yêu cầu.

Research trước khi:

- khu vực codebase còn lạ
- thay đổi liên quan tới pattern hoặc constraint sẵn có
- cần xem chức năng tương tự đang được làm thế nào

## `kn-research` tìm gì?

`kn-research` bắt đầu từ context do project sở hữu trước khi đi ra ngoài repo:

- Knowns `search` và `retrieve` cho docs, tasks, memory, và decisions
- Knowns `code` tools cho symbols, definitions, references, diagnostics, và code navigation an toàn
- specialized external MCP providers, nếu runtime có, cho upstream/library facts như Context7/library docs, GitHub/source MCP, hoặc official docs MCP
- general web search chỉ khi specialized MCP provider không có, không đủ, hoặc user yêu cầu internet research rõ ràng

Với research scope lớn, skill có thể tách thành các track độc lập và dùng sub-agents khi runtime expose sub-agent tools. External findings dùng để bổ trợ source-of-truth local như docs, tasks, và source files, không silently override chúng.

## Full SDD flow

Dùng cho feature lớn hoặc thay đổi đáng có spec riêng.

### 1. Init session

```text
/kn-init
```

Đọc project context, guidance, docs, trạng thái hiện tại.

### 2. Research

```text
/kn-research
```

Gom đủ context từ project và upstream sources trước khi viết spec.

### 3. Tạo spec

```text
/kn-spec user-auth
```

AI tạo spec document, thường gồm:

- overview và requirements
- acceptance criteria
- scenarios và edge cases

### 4. Chạy approved spec flow

Sau khi review và approve spec, dùng `kn-flow` cho SDD path end-to-end thông thường:

```text
/kn-flow @doc/specs/user-auth
```

`kn-flow` discover hoặc generate linked tasks, schedule phần việc an toàn, plan, implement, chạy review, fix blocking findings, rồi verify spec/task set.

Trong Codex, `$kn-flow` có thể tự spawn sub-agents sau khi report schedule, nhưng chỉ với parallel-safe task waves. Dùng `--sequential` khi muốn ép mọi work chạy trong main context.

### Manual task-only path

Nếu chỉ muốn generate tasks và tự chạy từng task, dùng:

```text
/kn-plan --from @doc/specs/user-auth
```

AI tách spec thành tasks, map ngược về spec AC.

Sau đó chạy từng task:

```text
/kn-implement 42
```

### 5. Verify

```text
/kn-verify
```

Check:

- AC coverage
- reference integrity
- spec/task consistency

### 6. Extract

```text
/kn-extract
```

Dùng khi implementation tạo ra pattern, decision, hoặc lesson đáng giữ lại.

## Normal flow

Feature nhỏ, task đã có, vấn đề đã rõ.

1. `/kn-init`
2. `/kn-plan 42`
3. `/kn-implement 42`

## Quick Fix flow

Bug fix, hotfix, sửa nhỏ.

1. `/kn-init`
2. `/kn-implement 42`

## Khi nào dùng `kn-flow`

Dùng `kn-flow` khi đã có approved spec hoặc một task wave và muốn workflow được orchestrate đầy đủ:

- task discovery hoặc generation
- planning
- implementation
- code review qua `kn-review`
- integration và verification

Approved-spec path điển hình:

```text
/kn-spec user-auth
(approve spec)
/kn-flow @doc/specs/user-auth
```

Trong Codex, dùng `$kn-spec` và `$kn-flow`. `$kn-flow` có thể delegate parallel-safe waves cho sub-agents; thêm `--sequential` để opt out.

## Khi nào dùng `kn-go`

`kn-go` là legacy no-review-gates pipeline cho approved specs.

Dùng khi:

- spec đã approved
- muốn task generation → planning → implementation → verification → commit prep chạy liền một mạch
- không cần review từng task trước khi code

Ưu tiên `/kn-flow` cho normal approved-spec execution. Ưu tiên `/kn-plan` + `/kn-implement` khi:

- muốn xem kỹ từng task trước khi code
- spec vẫn đang thay đổi
- cần review checkpoints rõ ràng giữa các pha

## Khi nào dùng `kn-debug`

Dùng khi bị block bởi lỗi thật sự, không phải thiếu plan.

Các case điển hình:

- build error, type error
- test fail
- runtime crash
- integration failure
- task bị block mà chưa rõ root cause

Nói ngắn: nếu bước tiếp theo hợp lý nhất là reproduce → diagnose → fix có hệ thống, thì chuyển sang `kn-debug` thay vì cứ tiếp tục implement.

## Khi nào dùng `kn-extract`

Dùng khi vừa hoàn thành phần việc tạo ra thứ gì đó reusable, không nên để chôn trong một task hay chat session.

Các case điển hình:

- tìm ra implementation pattern lặp lại được
- chốt project-level decision mà các phần việc sau cần follow
- gặp failure mode mà cách nhận biết và fix nên được nhớ lại
- muốn chuyển ad-hoc knowledge thành docs, memory, hoặc template

Nên dùng gần cuối task hoặc sau verify, khi đã biết chắc kết quả đáng lưu.

## Skill reference

| Skill | Mục đích |
|---|---|
| `/kn-init` | Load project context |
| `/kn-research` | Explore project context, code, và external MCP/web sources liên quan |
| `/kn-spec` | Tạo spec document |
| `/kn-flow` | Orchestrate approved spec hoặc task wave |
| `/kn-plan` | Tạo implementation plan |
| `/kn-implement` | Thực hiện công việc |
| `/kn-verify` | Check AC, refs, consistency |
| `/kn-review` | Review implemented work |
| `/kn-extract` | Lưu reusable knowledge |
| `/kn-doc` | Làm việc với docs |
| `/kn-template` | Chạy templates |
| `/kn-debug` | Debug khi bị block hoặc fail |

## CLI fallback

Nếu runtime không có skills, dùng CLI trực tiếp.

```bash
# Load context
knowns doc list --plain
knowns doc "readme" --plain --smart

# Nhận task
knowns task edit 42 -s in-progress -a @me
knowns time start 42

# Thêm plan
knowns task edit 42 --plan '1. Research\n2. Implement\n3. Test'

# Check AC và thêm notes
knowns task edit 42 --check-ac 1
knowns task edit 42 --append-notes "Completed feature X"

# Xong
knowns time stop
knowns task edit 42 -s done
```

## Tách session khi cần

Với công việc lớn, nên tách session riêng theo task hoặc pha.

Ví dụ:

- một session cho research
- một session cho spec + planning
- một session cho implementation

Giảm nguy cơ context bị compact, mỗi session dễ kiểm soát hơn.

## Khi nào coi là "xong"

Một task coi là done khi:

- AC đã check
- notes/implementation details đã ghi lại
- timer đã stop (nếu đang track time)
- validation/test đã pass
- task status đã update đúng

## Xem thêm

- [Quản lý task](./task-management.md)
- [Làm việc với AI](./ai-agent-guide.md)
- [Workflow](./workflow.md)
