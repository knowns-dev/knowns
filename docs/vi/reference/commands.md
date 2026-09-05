# Lệnh

Dùng `knowns <command> --help` để xem syntax chính xác. Trang này là tổng quan thực dụng.

## Conventions

- `--plain` khi AI hoặc script cần text output dễ parse
- `--json` khi cần structured output
- `knowns sync` khi muốn generated files khớp lại với config

## Init và sync

```bash
knowns init
knowns init my-project --no-wizard
knowns init --force
knowns init --no-wizard --task-prefix KN
knowns setup --global
knowns setup claude --global
knowns setup codex --global
knowns setup hermes --global
knowns setup all --global
knowns setup agents
knowns setup
knowns setup claude
knowns setup codex
knowns setup hermes
knowns sync
knowns sync --skills
knowns sync --instructions
knowns sync --model
knowns update
knowns update --check
knowns settings
knowns settings --global
```

`knowns init` tạo `.knowns/`, config, git tracking, semantic setup, và lightweight project instruction shims như `CLAUDE.md`/`AGENTS.md`. Runtime-critical AI guidance nằm trong MCP `initial` và on-demand `help`. Dùng `knowns setup <target> --global` cho personal assistant setup thông thường vì nó update user-level MCP config, skills, và runtime hooks trên nhiều repository. Ví dụ: `knowns setup hermes --global` cấu hình Hermes MCP config và skills ở user scope. Chỉ dùng `knowns setup <target>` khi bạn chủ ý muốn project-level integration artifacts trong repo. Dùng `knowns setup agents` khi chỉ muốn repo-local agent shims.

`knowns settings` mở settings center để chỉnh project name, git tracking, AI platforms, search, code intelligence, và maintenance guidance. Trong Search settings, các embedding model mà Ollama đang phục vụ được liệt kê để chọn; `knowns settings` không bao giờ tự pull model. `knowns settings --global` lưu defaults cho các lần `knowns init` sau. Dùng `knowns config get/set/list/reset` khi cần thao tác config bằng script hoặc agent.

## Task

```bash
knowns task create "Title" -d "Description"
knowns task create "Feature riêng" --prefix FR
knowns task create "Add auth" \
  --ac "User can login" \
  --ac "JWT token returned" \
  --priority high \
  -l auth

knowns task list --plain
knowns task list --status in-progress --assignee @me
knowns task <id> --plain

knowns task edit <id> -s in-progress
knowns task edit <id> --check-ac 1
knowns task edit <id> --append-notes "Completed middleware"
knowns task edit <id> --plan '1. Research\n2. Implement\n3. Test'
```

Khi truyền `--prefix`, Knowns tạo ID như `FR-4F7Q2M`. Prefix được chuẩn hoá
thành chữ hoa, dài 2-8 ký tự chữ/số và phải bắt đầu bằng chữ. Đây là override
cho một task, không thay đổi config. Nếu bỏ qua, Knowns dùng
`settings.defaultTaskIdPrefix`; project chưa cấu hình vẫn dùng ID lowercase
6 ký tự như trước.

## Doc

```bash
knowns doc create "Architecture" -d "System overview" -f architecture
knowns doc create "Auth Pattern" -d "JWT auth pattern" -f patterns -t auth -t security

knowns doc list --plain
knowns doc "architecture/auth" --plain
knowns doc "architecture/auth" --info --plain
knowns doc "architecture/auth" --toc --plain
knowns doc "architecture/auth" --section "2" --plain

knowns doc edit "architecture/auth" -a "\n\n## Notes\n..."
knowns doc edit "architecture/auth" -c "# New content"
knowns doc edit "architecture/auth" --section "2" -c "## 2. Updated section"
```

## Search, retrieve, resolve

```bash
knowns search "authentication" --plain
knowns search "jwt" --type doc --plain
knowns search "jwt" --keyword --plain
knowns search --status-check
knowns search --reindex

knowns retrieve "how auth works" --json
knowns retrieve "auth flow" --source-types doc,task --json

knowns resolve "@doc/specs/auth{implements}" --plain
knowns resolve "@doc/specs/auth{depends}" --direction inbound --depth 2 --plain
```

## Memory

```bash
knowns memory create "We use repository pattern" --category pattern
knowns memory list --plain
knowns memory <id> --plain
knowns memory edit <id> --append "More detail"
```

## Decision

```bash
knowns decision create "Use Postgres for metadata"
knowns decision list --plain
knowns decision get <id> --plain
knowns decision link <id> --source @doc/architecture/storage --task <done-task-id>
knowns decision accept <id>
knowns decision resolve create_draft "Use Postgres for metadata"
knowns decision supersede <old-id> <new-id>

knowns decision migrate preview --plain
knowns decision migrate apply --memory <memory-id> --resolution create_decision
knowns decision migrate rollback <memory-id>
```

Spec Decision là các rule `D1`, `D2`, … được khóa trong spec đã approve. Các lệnh trên quản lý System Decision: lựa chọn project bền vững luôn bắt đầu ở draft, cần source đọc được cùng evidence từ task hoàn tất trước khi accept, và có thể supersede về sau thay vì sửa đè lịch sử.

Migration Decision Memory legacy luôn preview trước, explicit theo từng record, có journal và có thể rollback. Các resolution gồm `create_decision`, `link_existing`, `consolidate_duplicate`, `reclassify`, `archive_noise`, `reject_noise`, `leave_unchanged`; không có bulk apply ngầm.

## Templates

```bash
knowns template list
knowns template get <name>
knowns template run <name>
knowns template create <name>
```

## Code intelligence

### Quản lý LSP

```bash
knowns lsp list                    # Hiển thị ngôn ngữ được hỗ trợ và trạng thái
knowns lsp install <language>      # Tải và cài đặt LSP server
knowns lsp cleanup                 # Xóa các phiên bản LSP server cũ
```

Knowns tự động phát hiện ngôn ngữ trong project và kiểm tra LSP binaries. Nếu thiếu binary, `knowns lsp list` sẽ hiển thị hướng dẫn cài đặt.

### Code operations (qua MCP)

Code intelligence dựa trên LSP và được truy cập qua MCP `code` tool:

- `symbols` — liệt kê symbols trong file
- `find` — tìm symbols theo name pattern, có thể kèm body/depth
- `definition` — đi tới definition
- `references` — tìm tất cả references
- `implementations` — tìm implementations của interface
- `diagnostics` — lấy compile errors/warnings
- `rename` — đổi tên symbol trong toàn workspace
- `replace` — thay text bằng regex/literal
- `replace_body` — thay toàn bộ body của symbol
- `insert` — chèn code trước/sau một symbol
- `delete` — xóa an toàn với kiểm tra references

### Inspect code index bằng CLI

```bash
knowns code symbols --plain
knowns code search "AuthService" --plain
knowns code deps --plain
```

Dùng CLI `code` commands để inspect indexed symbols/dependencies. Dùng MCP `code` tool cho navigation và edits có cấu trúc.

## Validation

```bash
knowns validate --plain
knowns validate --scope docs --plain
knowns validate --scope sdd --plain
knowns validate --strict --plain
```

## Time tracking

```bash
knowns time start <task-id>
knowns time stop
knowns time add <task-id> 1h30m -n "Pair programming"
knowns time report
```

## Browser UI

```bash
knowns browser
knowns browser --open
knowns browser --port 6421
```

## Project status và audit

```bash
knowns status
knowns audit recent
knowns audit stats
```

Dùng `status` để xem project readiness, và `audit` để inspect MCP tool calls gần đây.

## Guidance files

```bash
knowns setup
knowns sync --skills
knowns sync --instructions
```

## Embedding model

Không còn lệnh `knowns model`. Model được pull bằng Ollama và chọn bằng
`knowns config`:

```bash
ollama pull qwen3-embedding:0.6b
knowns config set settings.semanticSearch.model qwen3-embedding:0.6b
knowns search --reindex
```

Xem [Ollama Embedding Models](./ollama-embedding-models.md) để biết bộ model
khuyến nghị, lệnh cài/pull, và cách trỏ Knowns tới provider
OpenAI-compatible của bên thứ ba.

## Provider và runtime adapters

```bash
knowns provider list
knowns provider add --id openai --name "OpenAI" --api-base https://api.openai.com/v1 --api-key <key>
knowns provider test <id>
knowns provider remove <id>

knowns runtime status
knowns runtime install codex
knowns runtime ps
knowns runtime logs
knowns runtime stop
knowns runtime uninstall codex

knowns runtime-memory hook
knowns runtime-memory hook --json
```

Dùng provider commands cho API-backed embedding providers. Dùng runtime commands để install và inspect runtime memory adapters/shared runtime.

Default hook output là plain prompt context cho runtime adapters. Mỗi injected memory có inline score/trust metadata, ví dụ `score=0.92; trust=active`, để assistant tự cân nhắc supplemental context.

Dùng `knowns runtime-memory hook --json` khi caller cần structured metadata thay vì prompt text. JSON output có retrieval item scores và capture trust metadata như `capture.score`, `capture.threshold`, `capture.trusted`, và review `capture.matches` khi cần review.

## Tunnel

```bash
knowns tunnel status
knowns tunnel stop
```

Dùng tunnel commands để inspect hoặc stop Cloudflare Quick Tunnels cho local server sharing.

## Import

```bash
knowns import add <name> <source>
knowns import sync
knowns import list
```
