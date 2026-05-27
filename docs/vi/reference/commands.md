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
knowns setup
knowns setup claude
knowns setup opencode
knowns setup all
knowns sync
knowns sync --skills
knowns sync --instructions
knowns sync --model
knowns update
knowns update --check
```

## Task

```bash
knowns task create "Title" -d "Description"
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
knowns memory add "We use repository pattern" --category decision
knowns memory list --plain
knowns memory <id> --plain
knowns memory edit <id> --append "More detail"
```

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

## Guidance files

```bash
knowns setup
knowns sync --skills
knowns sync --instructions
```

## Model

```bash
knowns model list
knowns model download multilingual-e5-small
knowns model set multilingual-e5-small
knowns model status
```

## Import

```bash
knowns import add <name> <source>
knowns import sync
knowns import list
```
