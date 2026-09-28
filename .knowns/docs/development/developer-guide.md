---
id: doc-0d348a7070f27690ec75bcd4b23881dd
title: Developer Guide
description: Technical documentation for contributors and developers
createdAt: '2025-12-29T11:50:54.275Z'
updatedAt: '2026-09-24T19:16:36.443Z'
tags:
  - docs
  - developer
  - architecture
---

# Knowns Developer Guide

Technical documentation for contributors and developers building on Knowns. Knowns is implemented in Go and distributed as a single static binary.

---

## Architecture Overview

Knowns is a Go CLI application following a layered architecture with CLI as the primary interface.

### Tech Stack

| Layer | Technology |
|-------|------------|
| Language | Go 1.25+ |
| CLI Framework | Cobra |
| TUI | Lipgloss + Bubbletea |
| HTTP Server | Chi router + SSE + WebSocket (gorilla/websocket) |
| Web UI | React 19 + Vite + TailwindCSS 4 (embedded via `go:embed`) |
| UI Components | Radix UI (shadcn/ui) |
| Storage | File-based (Markdown + YAML Frontmatter) |
| AI Integration | mcp-go (Model Context Protocol) |
| Semantic Search | SQLite vec store + ONNX Runtime embeddings |
| Testing | `go test` with race detector |
| Linting | golangci-lint / gofmt |

### Module Structure

```
cmd/
└── knowns/
    └── main.go                  # Entry point
internal/
├── cli/                         # Cobra CLI commands
│   ├── root.go                  # Root command + banner
│   ├── task.go                  # Task CRUD
│   ├── doc.go                   # Document management
│   ├── time.go                  # Time tracking
│   ├── search.go                # Full-text + semantic search
│   ├── browser.go               # Web UI launcher
│   ├── agents.go                # AI guidelines management
│   ├── validate.go              # Validation commands
│   ├── template.go              # Template commands
│   ├── config.go                # Config management
│   ├── helpers.go               # Shared CLI utilities
│   ├── styles.go                # Lipgloss style definitions
│   └── ...
├── models/                      # Domain Models (Go structs)
│   ├── task.go                  # Task struct + helpers
│   ├── doc.go                   # Doc struct
│   ├── config.go                # Project/Settings structs
│   ├── time.go                  # Time tracking models
│   ├── template.go              # Template models
│   ├── version.go               # Version history
│   ├── search.go                # Search result types
│   └── workspace.go             # Workspace models
├── storage/                     # Persistence Layer (file I/O)
│   ├── store.go                 # Top-level Store coordinator
│   ├── task_store.go            # Task read/write
│   ├── doc_store.go             # Doc read/write
│   ├── config_store.go          # Config read/write
│   ├── time_store.go            # Time tracking persistence
│   ├── template_store.go        # Template read/write
│   ├── version_store.go         # Version history
│   ├── workspace_store.go       # Workspace persistence
│   └── util.go                  # Shared storage helpers
├── mcp/                         # MCP Server (mcp-go library)
│   ├── server.go                # MCPServer setup + tool registration
│   └── handlers/                # One file per tool group
│       ├── doc.go
│       ├── project.go
│       ├── search.go
│       ├── task.go
│       ├── template.go
│       ├── time.go
│       └── validate.go
├── server/                      # HTTP Server (Chi + SSE + WebSocket)
│   ├── server.go                # Server setup, Chi router, UI embedding
│   ├── sse.go                   # SSE broker implementation
│   ├── routes/                  # REST API route handlers
│   │   ├── router.go            # Route registration
│   │   ├── broker.go            # SSE event types
│   │   ├── tasks.go
│   │   ├── docs.go
│   │   ├── search.go
│   │   ├── time.go
│   │   ├── templates.go
│   │   ├── config.go
│   │   ├── validate.go
│   │   ├── notify.go
│   │   ├── workspaces.go
│   │   └── ...
│   └── workspace/               # Workspace orchestration
├── search/                      # Semantic Search (ONNX embeddings)
│   ├── engine.go                # Search engine coordinator
│   ├── embedding.go             # ONNX Runtime embedding
│   ├── tokenizer.go             # Tokenizer for models
│   ├── chunker.go               # Document chunking
│   ├── index.go                 # Index management
│   ├── sqlite_vecstore.go       # SQLite vector store
│   ├── vecstore.go              # Vector store interface
│   ├── cosine.go                # Cosine similarity
│   └── types.go                 # Search types
├── codegen/                     # Templates + Skills
│   ├── template_engine.go       # Handlebars template rendering
│   ├── helpers.go               # Template helpers
│   └── skill_sync.go            # Skill synchronization
└── util/                        # Shared Utilities
    ├── helpers.go               # General helpers
    ├── version.go               # Version info (set via ldflags)
    └── update_notifier.go       # Update checker
ui/                              # React Web UI (embedded via go:embed)
├── embed.go                     # go:embed directive for dist/
├── src/                         # React source
├── dist/                        # Built assets (embedded into binary)
├── package.json
└── vite.config.ts
```

---

## Domain Model

### Task Model

```go
// internal/models/task.go

type Task struct {
    ID          string   `json:"id"          yaml:"id"`          // Unique 6-char base36 ID (e.g., "abc123")
    Title       string   `json:"title"       yaml:"title"`
    Description string   `json:"description,omitempty" yaml:"description,omitempty"`
    Status      string   `json:"status"      yaml:"status"`      // todo | in-progress | in-review | blocked | done
    Priority    string   `json:"priority"    yaml:"priority"`    // low | medium | high
    Assignee    string   `json:"assignee,omitempty" yaml:"assignee,omitempty"`
    Labels      []string `json:"labels"      yaml:"labels"`
    Parent      string   `json:"parent,omitempty" yaml:"parent,omitempty"` // Parent task ID for subtasks
    Subtasks    []string `json:"subtasks,omitempty" yaml:"-"`     // Derived at load time
    Spec        string   `json:"spec,omitempty" yaml:"spec,omitempty"`
    Fulfills    []string `json:"fulfills,omitempty" yaml:"fulfills,omitempty"`
    Order       *int     `json:"order,omitempty" yaml:"order,omitempty"`
    CreatedAt   time.Time `json:"createdAt"  yaml:"createdAt"`
    UpdatedAt   time.Time `json:"updatedAt"  yaml:"updatedAt"`

    // Stored in markdown body sections, not YAML frontmatter:
    AcceptanceCriteria  []AcceptanceCriterion `json:"acceptanceCriteria" yaml:"-"`
    TimeSpent           int          `json:"timeSpent"    yaml:"timeSpent"`
    TimeEntries         []TimeEntry  `json:"timeEntries,omitempty" yaml:"-"`
    ImplementationPlan  string       `json:"implementationPlan,omitempty" yaml:"-"`
    ImplementationNotes string       `json:"implementationNotes,omitempty" yaml:"-"`
}

type AcceptanceCriterion struct {
    Text      string `json:"text"`
    Completed bool   `json:"completed"`
}
```

### Document Model

```go
// internal/models/doc.go

type Doc struct {
    Path        string    `json:"path"`                          // Relative path inside .knowns/docs/ without .md
    Title       string    `json:"title"       yaml:"title"`
    Description string    `json:"description,omitempty" yaml:"description,omitempty"`
    Content     string    `json:"content,omitempty" yaml:"-"`    // Markdown body (not in frontmatter)
    Tags        []string  `json:"tags,omitempty" yaml:"tags,omitempty"`
    Order       *int      `json:"order,omitempty" yaml:"order,omitempty"`
    CreatedAt   time.Time `json:"createdAt"   yaml:"createdAt"`
    UpdatedAt   time.Time `json:"updatedAt"   yaml:"updatedAt"`
    Folder      string    `json:"folder,omitempty" yaml:"-"`     // Derived at load time
    IsImported  bool      `json:"isImported,omitempty"`
    ImportSource string   `json:"importSource,omitempty"`
}
```

### Project Configuration

```go
// internal/models/config.go

type Project struct {
    Name      string          `json:"name"`
    ID        string          `json:"id"`
    CreatedAt time.Time       `json:"createdAt"`
    Settings  ProjectSettings `json:"settings"`
}

type ProjectSettings struct {
    DefaultAssignee string   `json:"defaultAssignee,omitempty"`
    DefaultPriority string   `json:"defaultPriority"`
    DefaultLabels   []string `json:"defaultLabels,omitempty"`
    TimeFormat      string   `json:"timeFormat,omitempty"`       // "12h" or "24h"
    GitTrackingMode string   `json:"gitTrackingMode,omitempty"`  // "git-tracked", "git-ignored", "none"
    Statuses        []string `json:"statuses"`
    StatusColors    map[string]string `json:"statusColors,omitempty"`
    VisibleColumns  []string `json:"visibleColumns,omitempty"`
    SemanticSearch  *SemanticSearchSettings `json:"semanticSearch,omitempty"`
    ServerPort      int      `json:"serverPort,omitempty"`
}
```

---

## Storage System

### File Structure

```
.knowns/
├── config.json           # Project configuration
├── tasks/
│   ├── task-abc123 - Title.md
│   ├── task-def456 - Another.md
│   └── ...
├── docs/
│   ├── README.md
│   ├── guides/
│   │   └── getting-started.md
│   └── patterns/
│       └── architecture.md
├── versions/             # Version history
│   ├── task-abc123/
│   │   ├── v1.json
│   │   └── v2.json
│   └── ...
├── templates/            # Code generation templates
├── archive/              # Archived tasks
├── imports/              # Imported packages
├── worktrees/            # Workspace worktrees
└── .search/              # Semantic search index (SQLite)
```

### Markdown + Frontmatter Format

```markdown
---
id: "abc123"
title: Task Title
status: in-progress
priority: high
labels: [feature, auth]
assignee: "@harry"
createdAt: 2025-12-25T10:00:00.000Z
updatedAt: 2025-12-29T15:30:00.000Z
---

## Description

Task description in Markdown.

## Acceptance Criteria

- [x] First criterion (checked)
- [ ] Second criterion (unchecked)

## Implementation Plan

1. Step one
2. Step two

## Implementation Notes

Notes added after completion.
```

### Store API

The `storage.Store` is the top-level coordinator that holds typed sub-stores:

```go
// internal/storage/store.go

type Store struct {
    Root       string           // Absolute path to .knowns/ directory
    Tasks      *TaskStore
    Docs       *DocStore
    Config     *ConfigStore
    Time       *TimeStore
    Templates  *TemplateStore
    Versions   *VersionStore
    Workspaces *WorkspaceStore
}

// NewStore creates a Store rooted at the given .knowns/ directory path.
func NewStore(root string) *Store

// FindProjectRoot walks up from startDir looking for a .knowns/ directory.
func FindProjectRoot(startDir string) (string, error)
```

Each sub-store provides CRUD operations for its domain:

```go
// TaskStore example methods
func (ts *TaskStore) Create(task *models.Task) error
func (ts *TaskStore) Get(id string) (*models.Task, error)
func (ts *TaskStore) List() ([]*models.Task, error)
func (ts *TaskStore) Update(task *models.Task) error
func (ts *TaskStore) Delete(id string) error

// DocStore example methods
func (ds *DocStore) Create(doc *models.Doc) error
func (ds *DocStore) Get(path string) (*models.Doc, error)
func (ds *DocStore) List() ([]*models.Doc, error)
func (ds *DocStore) Update(doc *models.Doc) error
```

---

## SSE Protocol (Server-Sent Events)

### Connection

```
GET http://localhost:3737/api/events
```

SSE is a unidirectional (server -> client) protocol that auto-reconnects on connection loss. The server also supports WebSocket connections for bidirectional communication.

### Event Types

#### Server -> Client

```go
// internal/server/routes/broker.go

// SSEEvent represents an event broadcast to SSE/WS clients.
type SSEEvent struct {
    Type string      `json:"type"`
    Data interface{} `json:"data"`
}

// Event types:
// "tasks:updated"   - Task was modified   { task: Task }
// "tasks:refresh"   - Full refresh needed {}
// "time:updated"    - Timer state changed { active: TimerState }
// "docs:updated"    - Doc was modified    { docPath: string }
```

### Connection Flow

1. Client connects to SSE endpoint (`/api/events`) or WebSocket
2. Server sends `connected` event
3. On any data change, server broadcasts to all clients via `SSEBroker`
4. Client updates local state
5. On reconnection (e.g., after sleep), client triggers full refresh

### CLI Integration

When CLI modifies data, it can notify the running server via HTTP:

```go
// internal/server/routes/notify.go

// NotifyRoutes handles /api/notify endpoints:
// POST /api/notify/task/{id}   - broadcasts tasks:updated
// POST /api/notify/doc/*       - broadcasts docs:updated
// POST /api/notify/time        - broadcasts time:updated
// POST /api/notify/refresh     - broadcasts full refresh
```

The server uses Chi router for all HTTP routing and the `SSEBroker` struct (`internal/server/sse.go`) to manage client connections and broadcast events.

---

## MCP Server Implementation

### Protocol

JSON-RPC 2.0 over stdio, implemented using the [mcp-go](https://github.com/mark3labs/mcp-go) library.

### Architecture

The MCP server (`internal/mcp/server.go`) wraps the `mcp-go` server and manages a reference to the active `storage.Store`. The store is `nil` until `set_project` is called by the AI agent.

```go
// internal/mcp/server.go

type MCPServer struct {
    srv   *server.MCPServer
    mu    sync.RWMutex
    store *storage.Store
    root  string
}

func NewMCPServer() *MCPServer
func (s *MCPServer) Serve() error  // Runs stdio transport
```

### Available Tools

Tools are grouped by domain in `internal/mcp/handlers/`:

| File | Tools |
|------|-------|
| `project.go` | `detect_projects`, `set_project`, `get_current_project` |
| `task.go` | `get_task`, `list_tasks`, `create_task`, `update_task` |
| `doc.go` | `get_doc`, `list_docs`, `create_doc`, `update_doc` |
| `search.go` | `search`, `reindex_search` |
| `time.go` | `start_time`, `stop_time`, `add_time`, `get_time_report` |
| `template.go` | `list_templates`, `get_template`, `create_template`, `run_template` |
| `validate.go` | `validate` |

### Adding a New Tool

1. Create or edit a handler file in `internal/mcp/handlers/`
2. Define a `Register*Tools` function that registers tools on the `mcp-go` server
3. Call the registration function from `NewMCPServer()` in `internal/mcp/server.go`

Example:

```go
// internal/mcp/handlers/my_tool.go
package handlers

import (
    "context"
    "encoding/json"

    "github.com/howznguyen/knowns/internal/storage"
    "github.com/mark3labs/mcp-go/mcp"
    "github.com/mark3labs/mcp-go/server"
)

func RegisterMyTools(s *server.MCPServer, getStore func() *storage.Store) {
    s.AddTool(
        mcp.NewTool("my_new_tool",
            mcp.WithDescription("Does something useful"),
            mcp.WithString("name", mcp.Required(), mcp.Description("The name")),
        ),
        func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
            store := getStore()
            if store == nil {
                return mcp.NewToolResultError("No project set. Call set_project first."), nil
            }

            name := req.Params.Arguments["name"].(string)
            result, err := doSomething(store, name)
            if err != nil {
                return mcp.NewToolResultError(err.Error()), nil
            }

            data, _ := json.Marshal(result)
            return mcp.NewToolResultText(string(data)), nil
        },
    )
}
```

Then register in `internal/mcp/server.go`:

```go
func NewMCPServer() *MCPServer {
    // ... existing setup ...
    handlers.RegisterMyTools(s.srv, getStore)
    return s
}
```

---

## Template System

AI agent guidelines are embedded at build time using Go's `go:embed` directive.

### Template Matrix

| Type | Variant | Size | Use Case |
|------|---------|------|----------|
| cli | general | ~15KB | Claude, GPT-4, large context models |
| cli | gemini | ~3KB | Gemini 2.5 Flash, small context |
| mcp | general | ~12KB | Claude Desktop, full MCP reference |
| mcp | gemini | ~2.5KB | Gemini with MCP tools |

### How It Works

Guidelines markdown files are embedded into the Go binary using `go:embed` and served via the `guidelines` CLI command:

```go
// internal/cli/guidelines.go
import _ "embed"

//go:embed templates/cli/general.md
var cliGeneral string

//go:embed templates/cli/gemini.md
var cliGemini string

//go:embed templates/mcp/general.md
var mcpGeneral string

//go:embed templates/mcp/gemini.md
var mcpGemini string

func getGuidelines(guideType, variant string) string {
    if guideType == "mcp" {
        if variant == "gemini" {
            return mcpGemini
        }
        return mcpGeneral
    }
    if variant == "gemini" {
        return cliGemini
    }
    return cliGeneral
}
```

### Adding a New Template Variant

1. Create template file at the appropriate path (e.g., `internal/cli/templates/<type>/<variant>.md`)
2. Add `//go:embed` directive in the guidelines command file
3. Update `getGuidelines()` to handle the new variant
4. Add CLI flag if needed (e.g., `--<variant>`)

### Cobra Persistent Flags

When parent command has flags that should be available to subcommands, use Cobra's `PersistentFlags()`:

```go
var parentCmd = &cobra.Command{
    Use:   "parent",
    Short: "Parent command",
}

func init() {
    parentCmd.PersistentFlags().Bool("flag", false, "Description")
    parentCmd.AddCommand(childCmd)
}
```

Persistent flags are inherited by all subcommands automatically in Cobra.

---

## Contributing Guidelines

### Development Setup

```bash
# Clone repository
git clone https://github.com/howznguyen/knowns.git
cd knowns

# Download Go dependencies
go mod download

# Build the binary (output: dist/knowns)
make build

# Or build with race detector for development
make dev

# Install to GOPATH/bin
make install
```

### Building the UI

The React web UI is compiled separately and embedded into the Go binary via `go:embed`:

```bash
# Build the React UI (requires Node.js + pnpm)
make ui

# Then rebuild the Go binary to embed the new UI assets
make build
```

### Code Style

- **Formatter**: `gofmt` (included with Go, enforced automatically)
- **Linter**: `golangci-lint`
- **Run lint**: `make lint` or `golangci-lint run ./...`
- Go conventions: exported names are PascalCase, unexported are camelCase
- Use `internal/` packages to prevent external imports
- Error handling: always check and return errors, never ignore them silently

### Testing

```bash
# Unit tests with race detector
make test
# or
go test -v -race -count=1 ./...

# E2E tests (requires built binary)
make test-e2e

# E2E tests including semantic search (requires ONNX Runtime)
make test-e2e-semantic
```

Tests live alongside the code they test (Go convention: `foo_test.go` next to `foo.go`) or in the `tests/` directory for E2E tests.

### Git Workflow

1. Create feature branch from `develop`
2. Make changes with clear commits
3. Run tests and lint
4. Create PR to `develop`

### Commit Message Format

```
<type>: <description>

[optional body]
```

Types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation
- `refactor`: Code refactoring
- `test`: Adding tests
- `chore`: Maintenance

### Adding a New Command

1. Create a new file in `internal/cli/` (e.g., `my_command.go`)
2. Define a `cobra.Command` variable
3. Register it in an `init()` function by adding it to the root command

Example:

```go
// internal/cli/my_command.go
package cli

import (
    "fmt"

    "github.com/spf13/cobra"
)

var myCmd = &cobra.Command{
    Use:   "my-command",
    Short: "Does something useful",
    RunE: func(cmd *cobra.Command, args []string) error {
        store := getStore()
        option, _ := cmd.Flags().GetString("option")

        // Implementation
        fmt.Println("Running my-command with option:", option)
        return nil
    },
}

func init() {
    myCmd.Flags().StringP("option", "o", "", "An option")
    rootCmd.AddCommand(myCmd)
}
```

### Adding UI Components

The React UI lives in `ui/` and is embedded into the Go binary at build time via `go:embed`:

```go
// ui/embed.go
package ui

import "embed"

//go:embed dist/*
var Assets embed.FS
```

Follow Atomic Design for component organization:
- **Atoms**: Basic elements (Button, Input) in `ui/src/components/atoms/`
- **Molecules**: Combinations (SearchBox, FormField) in `ui/src/components/molecules/`
- **Organisms**: Complex (TaskCard, Board) in `ui/src/components/organisms/`
- **Templates**: Page layouts in `ui/src/components/templates/`

Uses shadcn/ui primitives from `ui/src/components/ui/`.

After modifying UI code, rebuild with:

```bash
make ui && make build
```

### Cross-Compilation

Build for all supported platforms:

```bash
# Build for all 6 platforms (darwin/linux/windows x amd64/arm64)
make cross-compile

# Build for npm distribution packages
make npm-build
```

### Pull Request Checklist

- [ ] Tests pass (`make test`)
- [ ] Lint passes (`make lint`)
- [ ] Build works (`make build`)
- [ ] Documentation updated if needed
- [ ] Commit messages follow convention
