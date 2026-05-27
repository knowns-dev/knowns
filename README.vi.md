<p align="center">
  <img src="./images/logo.png" alt="Knowns" width="120">
</p>

<h1 align="center">Knowns</h1>

<p align="center">
  <a href="https://go.dev/"><img src="https://img.shields.io/badge/go-%3E%3D1.24.2-00ADD8?style=flat-square&logo=go" alt="Go"></a>
  <a href="https://www.npmjs.com/package/knowns"><img src="https://img.shields.io/npm/v/knowns.svg?style=flat-square" alt="npm"></a>
  <a href="https://github.com/knowns-dev/knowns/actions/workflows/ci.yml"><img src="https://github.com/knowns-dev/knowns/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="#cài-đặt"><img src="https://img.shields.io/badge/platform-win%20%7C%20mac%20%7C%20linux-lightgrey?style=flat-square" alt="Platform"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/knowns-dev/knowns?style=flat-square" alt="License"></a>
</p>

<p align="center">
  <a href="https://knowns.sh">Trang chủ</a> |
  <a href="./README.md">English</a> |
  <a href="./docs/vi/README.md">Tài liệu</a>
</p>

<p align="center">
  <strong>Cho AI coding assistant truy cập có cấu trúc vào task, doc, spec, và decision — để nó khỏi đoán mò.</strong>
</p>

---

Mỗi lần mở session mới với AI, bạn lại phải giải thích lại architecture, paste doc, nhắc lại convention, làm rõ decision cũ. AI rất mạnh — nhưng nó không nhớ gì giữa các session.

**Knowns fix đúng chỗ đó.** Cho AI assistants như Claude, Cursor, Copilot truy cập bền vững vào task, doc, spec, acceptance criteria, và architectural decisions của project. Thay vì prompt từ đầu, AI đọc đúng phần nó cần và tiếp tục từ chỗ bạn dừng.

Nếu bạn nghĩ AI nên thực sự hiểu software project, cho **Knowns** một star nhé.

<p align="center">
  <img src="./images/task-workflow.gif" alt="Knowns task workflow demo" width="100%">
</p>

## Mục lục

- [Tại sao cần Knowns?](#tại-sao-cần-knowns)
- [Trước và sau](#trước-và-sau)
- [Knowns là gì?](#knowns-là-gì)
- [Dành cho ai?](#dành-cho-ai)
- [Cách hoạt động](#cách-hoạt-động)
- [Quick start](#quick-start)
- [Khả năng chính](#khả-năng-chính)
- [Xây được gì với Knowns?](#xây-được-gì-với-knowns)
- [Claude Code skills workflow](#claude-code-skills-workflow)
- [Cài đặt](#cài-đặt)
- [Tài liệu](#tài-liệu)
- [Roadmap](#roadmap)
- [Development](#development)
- [Links](#links)

---

## Tại sao cần Knowns?

AI coding assistants là stateless. Mỗi session bắt đầu từ zero.

Kết quả là bạn phải làm đi làm lại:

- **Giải thích lại** architecture và design patterns
- **Paste lại** doc vào chat
- **Nhắc lại** coding conventions
- **Làm rõ lại** decision đã chốt tuần trước
- **Dựng lại context** mất 20 phút chuẩn bị

AI không thiếu thông minh. **Nó thiếu quyền truy cập vào những gì project đã biết.**

Knowns cho nó quyền truy cập đó.

---

## Trước và sau

| Không có Knowns | Có Knowns |
|---|---|
| "Bọn tôi dùng repository pattern..." _(paste 50 dòng)_ | AI tự đọc `@doc/patterns/repository` |
| "Đây là task, AC là..." _(gõ lại từ đầu)_ | AI đọc task, AC, linked spec và related docs |
| "Nhớ tuần trước quyết định..." _(hy vọng nó nhớ)_ | Decision lưu trong project memory — AI recall mỗi session |
| "Auth flow hoạt động thế này..." _(giải thích lần thứ 4)_ | AI follow `@doc/architecture/auth` và build tiếp |
| "Xong chưa nhỉ, để check lại requirements..." | AI tự check AC và validate completion |
| Session bắt đầu lạnh — mất 10 phút dựng context | Session bắt đầu ấm — AI đã biết project |

---

## Knowns là gì?

Knowns là **local-first, self-hostable project context layer** cho AI-native development.

Lưu project knowledge dưới dạng structured, AI-readable files — và expose cho AI assistants qua CLI và [MCP (Model Context Protocol)](https://modelcontextprotocol.io/).

<p align="center">
  <img src="./images/knowledge-graph.svg" alt="Knowns Knowledge Graph" width="100%">
</p>

Cụ thể, Knowns quản lý:

- **Tasks** với acceptance criteria, implementation plans, status tracking
- **Documentation** trong nested markdown folders có cross-references
- **Specs** define "xong" nghĩa là gì cho một feature
- **Memory** — project-level, session-level, global knowledge để AI recall
- **Templates** cho code generation bằng Handlebars
- **References** như `@task-42` và `@doc/patterns/auth` để AI follow và resolve
- **Code intelligence** — LSP-backed real-time code queries: symbols, definitions, references, rename, và editing actions

Tất cả nằm trong `.knowns/` của repo. Plain files. Commit vào Git được. Không cần cloud.

---

## Dành cho ai?

- **Solo developers** pair với AI hằng ngày, muốn AI nhớ project context across sessions
- **Teams** dùng AI assistants, chán cảnh ai cũng phải giải thích lại architecture
- **Open-source maintainers** muốn contributors (người hoặc AI) onboard nhanh hơn
- **Bất kỳ ai** dùng Claude, Cursor, Copilot, Windsurf hay AI coding tools khác và muốn chúng thực sự hiểu project

---

## Cách hoạt động

Knowns nằm cạnh tools bạn đang dùng. Stack hiện tại không cần đổi.

<p align="center">
  <img src="./images/architecture.svg" alt="Knowns Architecture" width="100%">
</p>

1. **Bạn cấu trúc project knowledge** — task, doc, spec, decision — bằng CLI hoặc Web UI
2. **AI đọc** — qua MCP hoặc CLI, AI truy cập đúng context nó cần
3. **AI hành động** — follow reference, check AC, update task status, build với full awareness
4. **Knowledge tích lũy** — decision, pattern, convention persist across sessions

Spec → understood. Task → connected. Doc → usable. Decision → remembered.

---

## Quick start

```bash
# Cài đặt
brew install knowns-dev/tap/knowns
# hoặc: npm install -g knowns
# hoặc: curl -fsSL https://knowns.sh/script/install | sh
# hoặc Windows PowerShell:
# irm https://knowns.sh/script/install.ps1 | iex

# Kiểm tra
knowns --version

# Init trong project
cd your-project
knowns init

# Hoặc chạy không cần cài global
npx knowns init

# Tạo task đầu tiên
knowns task create "Add user authentication" \
  -d "JWT-based auth with login and register endpoints" \
  --ac "User can register with email/password" \
  --ac "User can login and receive JWT token" \
  --ac "Protected routes reject unauthenticated requests"

# Thêm doc
knowns doc create "Auth Architecture" \
  -f "architecture" \
  -d "Authentication design decisions and patterns"

# Mở Web UI
knowns browser --open

# Update Knowns sau này
knowns update

# Kết nối AI assistant qua MCP
# Xem: docs/vi/guides/mcp-integration.md
```

Giờ khi AI đọc project, nó thấy structured tasks có AC, linked documentation, và clear definition of done — thay vì đoán.

---

## Khả năng chính

### Task & workflow management

Tạo task có acceptance criteria, implementation plan, status tracking. AI đọc task, follow plan, check AC, biết rõ khi nào xong.

```bash
knowns task create "Title" --ac "Criterion 1" --ac "Criterion 2"
knowns task edit <id> -s in-progress
knowns task edit <id> --check-ac 1
```

### Structured documentation

Tổ chức project knowledge trong nested markdown folders. Cross-reference bằng `@doc/path` và `@task-id`. AI follow references để load đúng context cần dùng.

```bash
knowns doc create "API Design" -f "architecture"
knowns doc "architecture/api-design" --smart --plain
```

### Project memory

Memory 3 layer — **project**, **session**, **global** — AI recall decisions, patterns, conventions mà không cần bạn nhắc lại.

```bash
knowns memory add "We use repository pattern for data access" --category decision
knowns memory list --plain
```

### Semantic search

Tìm theo ý nghĩa, không chỉ keyword. Chạy local bằng ONNX models — offline hoàn toàn, không cần API key.

```bash
knowns search "how does authentication work" --plain
```

### MCP integration

Full [Model Context Protocol](https://modelcontextprotocol.io/) server. Claude, Cursor và các MCP-compatible assistants truy cập trực tiếp task, doc, memory, search, validation — không cần copy-paste.

### Code intelligence

LSP-backed code intelligence cho Go, TypeScript, Python, Rust, C/C++, Java, C#, Ruby, PHP. Tự động phát hiện ngôn ngữ, hướng dẫn cài LSP server nếu thiếu. Truy cập qua MCP `code` tool với 11 actions.

```bash
knowns lsp list                    # Xem ngôn ngữ và trạng thái LSP
knowns lsp install <language>      # Tải và cài LSP server
```

### Templates & code generation

Handlebars-based templates cho scaffolding. Define pattern một lần, generate nhất quán.

```bash
knowns template list
knowns template run <name> --name "UserService"
```

### AI agent workspaces

Multi-phase agent orchestration với git worktree isolation, live terminal streaming, automatic phase progression (research → plan → implement → review).

### Web UI

Kanban board, document browser, knowledge graph visualization, mermaid support — tất cả trong local browser UI.

```bash
knowns browser --open
```

---

## Xây được gì với Knowns?

| Khả năng | Mô tả |
|---|---|
| **Task Management** | Task có AC, plan, status, time tracking |
| **Documentation** | Nested markdown folders có cross-references và mermaid |
| **Semantic Search** | Tìm theo ý nghĩa với local AI models (offline) |
| **Time Tracking** | Timer và report theo task |
| **Context Linking** | `@task-42` và `@doc/patterns/auth` references AI resolve được |
| **Validation** | Phát hiện broken references và incomplete tasks bằng `knowns validate` |
| **Template System** | Code generation bằng Handlebars (`.hbs`) templates |
| **Import System** | Import docs và templates từ git, npm, local |
| **Memory System** | Project / session / global memory cho persistent AI recall |
| **MCP Server** | AI assistant integration với full tool access |
| **AI Workspaces** | Multi-phase agent orchestration với worktree isolation |
| **Code Intelligence** | LSP-backed: symbols, definitions, references, rename, replace, insert, delete |
| **Web UI** | Kanban board, doc browser, knowledge graph, mermaid diagrams |

---

## Claude Code skills workflow

Khi dùng Claude Code với Knowns, skills (slash commands) tạo guided workflow:

<p align="center">
  <img src="./images/workflow.svg" alt="Knowns AI Workflow" width="100%">
</p>

```
/kn-init      -> Đọc project docs, hiểu context
/kn-plan      -> Nhận task, gom context, tạo plan (chờ approve)
/kn-implement -> Follow plan, check AC, track progress
/kn-commit    -> Commit theo conventional format
```

### Ví dụ session

```
Bạn: /kn-init
Claude: [Đọc README, ARCHITECTURE, check task backlog]
        "Project dùng NestJS với CQRS pattern. 3 tasks đang in-progress..."

Bạn: /kn-plan 42
Claude: [Nhận task, đọc refs, search docs]
        "Task #42: Add user authentication

         ## Implementation Plan
         1. Review @doc/patterns/auth
         2. Tạo AuthModule với JWT strategy
         3. Thêm login/register endpoints
         4. Viết unit tests

         Approve plan này?"

Bạn: OK

Bạn: /kn-implement 42
Claude: [Follow plan, generate code, check AC]
        "✓ AC1: User can login - DONE
         ✓ AC2: JWT token returned - DONE
         ✓ AC3: Tests pass - DONE

         Tất cả AC đã complete. Ready to commit?"

Bạn: /kn-commit
Claude: [Tạo conventional commit]
        "feat(auth): add JWT authentication

         - Add AuthModule with passport JWT strategy
         - Add login/register endpoints
         - Add unit tests (94% coverage)"
```

### Skills

| Skill | Mô tả |
|---|---|
| `/kn-init` | Init session — đọc docs, load memory, hiểu project |
| `/kn-plan <id>` | Nhận task, gom context, tạo implementation plan |
| `/kn-implement <id>` | Execute plan, track progress, check AC |
| `/kn-research` | Search codebase, tìm patterns, explore trước khi code |
| `/kn-commit` | Tạo conventional commit có verification |
| `/kn-spec` | Tạo spec document cho feature (SDD) |
| `/kn-go <spec>` | Full pipeline từ approved spec (không có review gates) |
| `/kn-verify` | Chạy SDD verification và coverage report |
| `/kn-review` | Multi-perspective code review (P1/P2/P3) |
| `/kn-doc` | Tạo hoặc update doc |
| `/kn-extract` | Extract reusable patterns vào docs, templates, memory |
| `/kn-template` | List, run, hoặc tạo template |
| `/kn-debug` | Debug errors với memory-backed triage |

---

## Cài đặt

### Homebrew (macOS/Linux)

```bash
brew install knowns-dev/tap/knowns
```

### Shell installer (macOS/Linux)

```bash
curl -fsSL https://knowns.sh/script/install | sh

# Hoặc wget
wget -qO- https://knowns.sh/script/install | sh

# Version cụ thể
curl -fsSL https://knowns.sh/script/install | KNOWNS_VERSION=0.18.0 sh
```

### PowerShell installer (Windows)

```powershell
irm https://knowns.sh/script/install.ps1 | iex

# Version cụ thể
$env:KNOWNS_VERSION = "0.18.0"; irm https://knowns.sh/script/install.ps1 | iex
```

Shell installer (macOS/Linux) và PowerShell installer (Windows) tự chạy `knowns search --install-runtime` sau khi cài binary. Nếu bước đó fail, chạy lại bằng tay.

### npm

```bash
# Global install — tự tải binary theo platform
npm install -g knowns

# Hoặc chạy không cần cài
npx knowns
```

### Build từ source (Go 1.24.2+)

```bash
go install github.com/howznguyen/knowns/cmd/knowns@latest

# Hoặc clone rồi build
git clone https://github.com/knowns-dev/knowns.git
cd knowns
make build        # Output: bin/knowns
make install      # Cài vào GOPATH/bin
```

### Gỡ cài đặt

```bash
# macOS/Linux
curl -fsSL https://knowns.sh/script/uninstall | sh

# Windows
irm https://knowns.sh/script/uninstall.ps1 | iex
```

Uninstall scripts chỉ xóa CLI binary và PATH entries do installer thêm. Không đụng tới `.knowns/` trong các project.

---

## Tra cứu nhanh

```bash
# Tasks
knowns task create "Title" -d "Description" --ac "Criterion"
knowns task list --plain
knowns task <id> --plain
knowns task edit <id> -s in-progress -a @me
knowns task edit <id> --check-ac 1

# Documentation
knowns doc create "Title" -d "Description" -f "folder"
knowns doc "doc-name" --plain
knowns doc "doc-name" --smart --plain
knowns doc "doc-name" --section "2" --plain

# Templates
knowns template list
knowns template run <name> --name "X"
knowns template create <name>

# Imports
knowns import add <name> <source>
knowns import sync
knowns import list

# Time, Search & Validate
knowns time start <id> && knowns time stop
knowns search "query" --plain
knowns validate

# Code intelligence
knowns lsp list
knowns lsp install <language>
knowns lsp cleanup

# AI Guidelines
knowns setup
knowns sync
```

---

## Tài liệu

| Guide | Mô tả |
|---|---|
| [Hướng dẫn sử dụng](./docs/vi/guides/user-guide.md) | Bắt đầu và sử dụng hằng ngày |
| [Lệnh](./docs/vi/reference/commands.md) | CLI commands chính và ví dụ |
| [Workflow](./docs/vi/guides/workflow.md) | Cách làm việc đề xuất |
| [MCP](./docs/vi/guides/mcp-integration.md) | MCP setup cho Claude, Cursor, Codex, OpenCode, ... |
| [Reference system](./docs/vi/reference/reference-system.md) | Cách `@doc/` và `@task-` hoạt động |
| [Semantic search](./docs/vi/reference/semantic-search.md) | Setup và sử dụng semantic search |
| [Templates](./docs/vi/integrations/templates.md) | Code generation bằng Handlebars templates |
| [Web UI](./docs/vi/guides/web-ui.md) | Board, doc browser, graph, chat UI |
| [Cấu hình](./docs/vi/reference/configuration.md) | Project config và options |
| [Skills](./docs/vi/integrations/skills.md) | Skills và sync paths theo platform |
| [Developer guide](./docs/vi/contributing/developer-guide.md) | Cho người đóng góp |
| [Platforms](./docs/vi/integrations/platforms.md) | Platform integration mapping |

---

## Roadmap

### AI Agent Workspaces ✅ (Active)

Multi-phase agent orchestration — giao task cho AI agents với git worktree isolation, live terminal streaming, automatic phase progression (research → plan → implement → review).

### Self-Hosted Team Sync 🚧 (Planned)

Optional self-hosted sync server cho shared visibility mà không bỏ local-first.

- **Real-time visibility** — biết ai đang làm gì
- **Shared knowledge** — sync task và doc across team
- **Full data control** — self-hosted, không phụ thuộc cloud

---

## Development

Cần **Go 1.24.2+** và tùy chọn **Node.js + pnpm** cho UI development.

```bash
make build              # Build binary -> bin/knowns
make dev                # Build với race detector
make test               # Unit tests
make test-e2e           # CLI + MCP E2E tests
make test-e2e-semantic  # E2E tests bao gồm semantic search
make lint               # golangci-lint
make cross-compile      # Build cho 6 platforms
make ui                 # Rebuild embedded Web UI (cần pnpm)
```

### Project structure

```
cmd/knowns/          # CLI entry point
internal/
  cli/               # Cobra commands
  models/            # Domain models
  storage/           # File-based storage (.knowns/)
  server/            # HTTP server, SSE, WebSocket
    routes/          # REST API handlers
    workspace/       # Agent orchestrator, process manager, worktree
  mcp/               # MCP server (stdio)
  search/            # Semantic search (ONNX)
ui/                  # Embedded React UI (built assets)
tests/               # E2E tests
```

---

## Links

- [npm](https://www.npmjs.com/package/knowns)
- [GitHub](https://github.com/knowns-dev/knowns)
- [Discord](https://discord.knowns.dev)
- [Changelog](./CHANGELOG.md)

Design principles và long-term direction: [Philosophy](./PHILOSOPHY.md).

Technical details: [Architecture](./ARCHITECTURE.md) và [Contributing](./CONTRIBUTING.md).

---

## Star History

<a href="https://www.star-history.com/?repos=knowns-dev%2Fknowns&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=knowns-dev/knowns&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=knowns-dev/knowns&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=knowns-dev/knowns&type=date&legend=top-left" />
 </picture>
</a>

---

<p align="center">
  <strong>What your AI should have knowns.</strong><br>
  Cho dev teams pair với AI.
</p>
