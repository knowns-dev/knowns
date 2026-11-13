---
id: doc-65874eda24d725ead3d44a32c271dd10
title: Naming Conventions
description: File and code naming conventions for the project
createdAt: '2025-12-25T15:16:58.868Z'
updatedAt: '2026-03-08T18:18:39.658Z'
tags:
  - conventions
---

---

## File Naming

| Type | Pattern | Example |
|------|---------|---------|
| CLI Command | `{entity}.go` | `task.go` |
| Store | `{entity}_store.go` | `task_store.go` |
| Store (utilities) | `util.go` | `util.go` |
| Model | `{entity}.go` | `task.go` |
| MCP Handler | `{entity}.go` | `task.go` |
| Codegen Module | `{name}.go` | `template_engine.go` |
| Helpers | `helpers.go` | `helpers.go` |
| Test | `{name}_test.go` | `task_store_test.go` |
| Config Store | `config_store.go` | `config_store.go` |
| Version Store | `version_store.go` | `version_store.go` |

### File Naming Rules

- Use `snake_case` for all Go file names (e.g., `task_store.go`, not `taskStore.go`)
- Test files use `_test.go` suffix (e.g., `task_store_test.go`)
- No file type suffixes like `.controller.go` or `.use-case.go` -- keep it flat
- Group by package, not by layer (e.g., `internal/storage/task_store.go`)
## Code Naming

| Type | Convention | Example |
|------|------------|---------|
| Exported Type | PascalCase | `TaskStore` |
| Unexported Type | camelCase | `taskEntry` |
| Interface | PascalCase | `Store` |
| Struct | PascalCase | `Task` |
| Exported Function | PascalCase | `NewStore()` |
| Unexported Function | camelCase | `parseMarkdown()` |
| Exported Variable | PascalCase | `DefaultPriority` |
| Unexported Variable | camelCase | `taskDir` |
| Constant | PascalCase | `MaxRetryCount` |
| Enum (iota) | PascalCase prefix | `StatusTodo`, `StatusInProgress` |
| Package Name | lowercase, single word | `storage`, `cli`, `mcp` |
| Receiver Name | 1-2 letter abbreviation | `func (s *Store) GetTask(...)` |

### Go-Specific Conventions

- **Exported = PascalCase**, **Unexported = camelCase** (enforced by Go compiler)
- **Interfaces**: Use `-er` suffix for single-method interfaces (e.g., `Reader`, `Writer`)
- **Constructors**: Use `New` prefix (e.g., `NewStore()`, `NewTask()`)
- **Getters**: Do NOT use `Get` prefix for simple field access (e.g., `task.Title()` not `task.GetTitle()`)
- **Package names**: lowercase, no underscores, no mixedCase (e.g., `storage`, not `fileStore`)
