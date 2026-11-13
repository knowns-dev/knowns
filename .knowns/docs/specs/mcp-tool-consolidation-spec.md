---
id: doc-63de5d968d183c5c8466fa8862d4f298
title: MCP Tool Consolidation Spec
description: Spec for refactoring 46 MCP tools into 10 domain-grouped tools
createdAt: '2026-04-23T04:42:19.999Z'
updatedAt: '2026-04-23T04:48:44.599Z'
tags:
  - mcp
  - refactoring
  - spec
  - approved
---

# MCP Tool Consolidation Spec

## 1. Mục tiêu

Refactor 46 MCP tool riêng lẻ thành **10 tool gộp theo domain**, mỗi tool sử dụng parameter `action` để dispatch đến logic tương ứng.

### Lý do
- **Context window**: 46 tool definition chiếm quá nhiều token trong context của LLM
- **Tool selection**: Agent mất thời gian chọn đúng tool khi có quá nhiều lựa chọn
- **Naming confusion**: Nhiều tool có tên gần giống (`add_memory` vs `add_working_memory`)
- **Maintainability**: Mỗi tool mới cần thêm 1 registration + 1 handler riêng

### Kết quả mong đợi
- 46 tool → 10 tool
- Giữ nguyên 100% chức năng hiện tại
- Backward-compatible response format (JSON output không đổi)
- Bỏ `reindex_search` (chuyển thành auto-trigger hoặc CLI-only)

## 2. Tool Mapping

### 2.1 `docs` tool
**Actions:** `create`, `get`, `update`, `delete`, `list`, `history`

| Action | Old Tool | Required Params | Optional Params |
|--------|----------|----------------|-----------------|
| `create` | `create_doc` | `title` | `content`, `description`, `folder`, `tags` |
| `get` | `get_doc` | `path` | `smart`, `toc`, `info`, `section`, `line` |
| `update` | `update_doc` | `path` | `title`, `description`, `content`, `section`, `appendContent`, `tags`, `newPath`, `clear` |
| `delete` | `delete_doc` | `path` | `dryRun` (default: true) |
| `list` | `list_docs` | — | `tag` |
| `history` | `get_doc_history` | `path` | — |

### 2.2 `tasks` tool
**Actions:** `create`, `get`, `update`, `delete`, `list`, `history`, `board`

| Action | Old Tool | Required Params | Optional Params |
|--------|----------|----------------|-----------------|
| `create` | `create_task` | `title` | `description`, `status`, `priority`, `labels`, `assignee`, `parent`, `spec`, `fulfills`, `order` |
| `get` | `get_task` | `taskId` | — |
| `update` | `update_task` | `taskId` | `title`, `description`, `status`, `priority`, `labels`, `assignee`, `plan`, `notes`, `appendNotes`, `addAc`, `removeAc`, `checkAc`, `uncheckAc`, `spec`, `fulfills`, `order`, `clear` |
| `delete` | `delete_task` | `taskId` | `dryRun` (default: true) |
| `list` | `list_tasks` | — | `status`, `priority`, `assignee`, `label`, `spec` |
| `history` | `get_task_history` | `taskId` | — |
| `board` | `get_board` | — | — |

### 2.3 `memory` tool
**Actions:** `add`, `get`, `update`, `delete`, `list`, `promote`, `demote`

| Action | Old Tool | Required Params | Optional Params |
|--------|----------|----------------|-----------------|
| `add` | `add_memory` | `content` | `title`, `layer`, `category`, `tags` |
| `get` | `get_memory` | `id` | — |
| `update` | `update_memory` | `id` | `title`, `content`, `category`, `tags`, `clear` |
| `delete` | `delete_memory` | `id` | `dryRun` (default: true) |
| `list` | `list_memories` | — | `layer`, `category`, `tag` |
| `promote` | `promote_memory` | `id` | — |
| `demote` | `demote_memory` | `id` | — |

### 2.4 `working_memory` tool
**Actions:** `add`, `get`, `delete`, `list`, `clear`

| Action | Old Tool | Required Params | Optional Params |
|--------|----------|----------------|-----------------|
| `add` | `add_working_memory` | `content` | `title`, `category`, `tags` |
| `get` | `get_working_memory` | `id` | — |
| `delete` | `delete_working_memory` | `id` | — |
| `list` | `list_working_memories` | — | — |
| `clear` | `clear_working_memory` | — | — |

### 2.5 `search` tool
**Actions:** `search`, `retrieve`, `resolve`

| Action | Old Tool | Required Params | Optional Params |
|--------|----------|----------------|-----------------|
| `search` | `search` | `query` | `type`, `mode`, `limit`, `status`, `priority`, `assignee`, `label`, `tag` |
| `retrieve` | `retrieve` | `query` | `mode`, `limit`, `sourceTypes`, `expandReferences`, `status`, `priority`, `assignee`, `label`, `tag` |
| `resolve` | `resolve` | `ref` | — |

**Bỏ:** `reindex_search` — chuyển thành auto-trigger khi data thay đổi hoặc CLI-only command.

### 2.6 `code` tool
**Actions:** `search`, `symbols`, `deps`, `graph`

| Action | Old Tool | Required Params | Optional Params |
|--------|----------|----------------|-----------------|
| `search` | `code_search` | `query` | `mode`, `limit`, `neighbors`, `edgeTypes` |
| `symbols` | `code_symbols` | — | `path`, `kind`, `limit` |
| `deps` | `code_deps` | — | `type`, `limit` |
| `graph` | `code_graph` | — | — |

### 2.7 `time` tool
**Actions:** `start`, `stop`, `add`, `report`

| Action | Old Tool | Required Params | Optional Params |
|--------|----------|----------------|-----------------|
| `start` | `start_time` | `taskId` | — |
| `stop` | `stop_time` | `taskId` | — |
| `add` | `add_time` | `taskId`, `duration` | `note`, `date` |
| `report` | `get_time_report` | — | `from`, `to`, `groupBy` |

### 2.8 `templates` tool
**Actions:** `create`, `get`, `list`, `run`

| Action | Old Tool | Required Params | Optional Params |
|--------|----------|----------------|-----------------|
| `create` | `create_template` | `name` | `description`, `doc` |
| `get` | `get_template` | `name` | — |
| `list` | `list_templates` | — | — |
| `run` | `run_template` | `name` | `variables`, `dryRun` (default: true) |

### 2.9 `project` tool
**Actions:** `detect`, `current`, `set`, `status`

| Action | Old Tool | Required Params | Optional Params |
|--------|----------|----------------|-----------------|
| `detect` | `detect_projects` | — | `additionalPaths` |
| `current` | `get_current_project` | — | — |
| `set` | `set_project` | `projectRoot` | — |
| `status` | `status` | — | — |

### 2.10 `validate` tool
**Giữ nguyên** — tool này đã là 1 tool duy nhất, không cần gộp.

Params: `scope`, `entity`, `strict`, `fix`

## 3. Implementation Pattern

### 3.1 Tool Definition Pattern

Mỗi grouped tool sẽ có:
- `action` parameter (required, enum)
- Tất cả params của mọi action (optional, validated trong handler)

```go
func RegisterTimeTools(s *server.MCPServer, getStore func() *storage.Store) {
    s.AddTool(
        mcp.NewTool("time",
            mcp.WithDescription("Time tracking operations. Use 'action' to specify: start, stop, add, report."),
            mcp.WithString("action",
                mcp.Required(),
                mcp.Description("Action to perform"),
                mcp.Enum("start", "stop", "add", "report"),
            ),
            // All params from all actions (optional, validated per action)
            mcp.WithString("taskId",
                mcp.Description("Task ID (required for start, stop, add)"),
            ),
            mcp.WithString("duration",
                mcp.Description("Duration e.g. '2h', '30m' (required for add)"),
            ),
            mcp.WithString("note", mcp.Description("Optional note (add)")),
            mcp.WithString("date", mcp.Description("Optional date YYYY-MM-DD (add)")),
            mcp.WithString("from", mcp.Description("Start date for report")),
            mcp.WithString("to", mcp.Description("End date for report")),
            mcp.WithString("groupBy",
                mcp.Description("Group report by task, label, or status"),
                mcp.Enum("task", "label", "status"),
            ),
        ),
        func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
            action, err := req.RequireString("action")
            if err != nil {
                return errResult("action is required")
            }
            switch action {
            case "start":
                return handleTimeStart(getStore, req)
            case "stop":
                return handleTimeStop(getStore, req)
            case "add":
                return handleTimeAdd(getStore, req)
            case "report":
                return handleTimeReport(getStore, req)
            default:
                return errResultf("unknown action: %s", action)
            }
        },
    )
}

// Each action handler is extracted as a separate function
func handleTimeStart(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
    // ... existing start_time logic
}
```

### 3.2 File Structure

```
internal/mcp/handlers/
├── board.go          → merged into task.go (action: board)
├── code.go           → refactored (action dispatch)
├── doc.go            → refactored (action dispatch)
├── memory.go         → refactored (action dispatch)
├── messages.go       → unchanged
├── notify.go         → unchanged
├── project.go        → refactored (action dispatch, absorbs status)
├── search.go         → refactored (action dispatch, removes reindex_search)
├── task.go           → refactored (action dispatch, absorbs board)
├── template.go       → refactored (action dispatch)
├── time.go           → refactored (action dispatch)
├── validate.go       → unchanged
├── working_memory.go → refactored (action dispatch)
└── helpers.go        → extract shared helpers (stringArg, intArg, etc.)
```

### 3.3 server.go Changes

```go
// Before (11 registration calls):
handlers.RegisterProjectTools(s.srv, getStore, setStore, getRoot)
handlers.RegisterTaskTools(s.srv, getStore)
handlers.RegisterDocTools(s.srv, getStore)
handlers.RegisterTimeTools(s.srv, getStore)
handlers.RegisterSearchTools(s.srv, getStore)
handlers.RegisterCodeTools(s.srv, getStore)
handlers.RegisterBoardTools(s.srv, getStore)
handlers.RegisterTemplateTools(s.srv, getStore)
handlers.RegisterValidateTools(s.srv, getStore)
handlers.RegisterMemoryTools(s.srv, getStore)
handlers.RegisterWorkingMemoryTools(s.srv, getStore, wmStore)

// After (10 registration calls, board merged into task):
handlers.RegisterProjectTool(s.srv, getStore, setStore, getRoot)
handlers.RegisterTaskTool(s.srv, getStore)
handlers.RegisterDocTool(s.srv, getStore)
handlers.RegisterTimeTool(s.srv, getStore)
handlers.RegisterSearchTool(s.srv, getStore)
handlers.RegisterCodeTool(s.srv, getStore)
handlers.RegisterTemplateTool(s.srv, getStore)
handlers.RegisterValidateTool(s.srv, getStore)
handlers.RegisterMemoryTool(s.srv, getStore)
handlers.RegisterWorkingMemoryTool(s.srv, getStore, wmStore)
```

## 4. Migration Strategy

### Phase 1: Extract helpers (không breaking change)
- Tạo `helpers.go` với `stringArg`, `intArg`, `stringSliceArg`, `stringSetArg`, `intSliceArg`, `containsString`
- Xóa duplicates từ `task.go`

### Phase 2: Refactor từng domain (mỗi domain 1 commit)
Thứ tự ưu tiên (đơn giản → phức tạp):
1. `time` (4 actions, đơn giản nhất — thiết lập pattern)
2. `code` (4 actions, không có write operations)
3. `working_memory` (5 actions, session-scoped)
4. `templates` (4 actions)
5. `project` (4 actions, absorb status)
6. `search` (3 actions, bỏ reindex_search)
7. `memory` (7 actions, có promote/demote)
8. `docs` (6 actions)
9. `tasks` (7 actions, absorb board — phức tạp nhất)
10. Cleanup: xóa `board.go`, update `server.go`

### Phase 3: Update documentation
- Update KNOWNS.md agent guidelines
- Update steering files
- Update skill files referencing old tool names

## 5. Acceptance Criteria

- [ ] AC-1: Tất cả 10 grouped tool được đăng ký và hoạt động
- [ ] AC-2: `reindex_search` bị loại bỏ khỏi MCP tools
- [ ] AC-3: `board.go` merged vào `task.go` (action: board)
- [ ] AC-4: `validate` giữ nguyên (không cần action parameter)
- [ ] AC-5: Shared helpers extracted vào `helpers.go`
- [ ] AC-6: Mỗi action handler là 1 function riêng (không inline trong switch)
- [ ] AC-7: Response format (JSON output) giữ nguyên cho mọi action
- [ ] AC-8: Error messages giữ nguyên
- [ ] AC-9: `go build ./...` pass
- [ ] AC-10: Existing tests pass (search_test.go)
- [ ] AC-11: Documentation updated (KNOWNS.md, steering files)

## 6. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Agent confusion với action parameter | Medium | Description rõ ràng cho mỗi tool, enum validation |
| Breaking existing agent workflows | High | Response format không đổi, chỉ đổi tool name + thêm action |
| Large PR khó review | Medium | Refactor từng domain, mỗi domain 1 commit |
| mcp-go schema validation | Low | Test từng tool sau refactor |

## 7. Out of Scope

- Thay đổi business logic của bất kỳ operation nào
- Thay đổi response format
- Thêm feature mới
- Refactor storage layer
- Refactor CLI layer
