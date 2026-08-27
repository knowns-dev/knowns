---
title: Architecture Overview
createdAt: '2025-12-29T07:06:54.131Z'
updatedAt: '2026-03-08T18:17:38.612Z'
description: High-level overview of Knowns architecture and how patterns connect
tags:
  - architecture
  - overview
---
## Overview

Knowns is a CLI-first knowledge layer and task management system for development teams. Designed to maintain persistent project context for AI assistance.

**Tagline**: "What your AI should have knowns."

## Tech Stack

| Layer | Technology |
|-------|------------|
| Language | Go 1.23+ |
| CLI | Cobra + Lipgloss/Bubbletea |
| Server | Chi (HTTP) + Gorilla (WebSocket) |
| Web UI | React 19 + Vite + TailwindCSS 4 (embedded via go:embed) |
| UI Components | Radix UI (shadcn/ui) |
| Storage | File-based (Markdown + YAML Frontmatter) |
| AI Integration | Model Context Protocol (mcp-go) |
| Testing | go test (standard library), Playwright + bun:test for the UI |
| Build | Make + goreleaser |
## Layered Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                User Interface Layer                          │
│                   (4 access points)                         │
├───────────┬───────────┬───────────┬─────────────────────────┤
│    CLI    │  Web UI   │ MCP Server│     AI Agents           │
│ (primary) │ (Kanban)  │ (Claude)  │   (consumers)           │
└─────┬─────┴─────┬─────┴─────┬─────┴───────────┬─────────────┘
      │           │           │                 │
      ▼           ▼           ▼                 ▼
┌─────────────────────────────────────────────────────────────┐
│                    Command Layer                             │
│  task.go | doc.go | time.go | search.go | browser.go | ...  │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                Storage & Service Layer                       │
│      FileStore | VersionStore | SearchEngine | Markdown      │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                  Domain Models Layer                         │
│          Task | Project | Version | References               │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                   File System Layer                          │
│    .knowns/tasks/ | .knowns/docs/ | config.json | versions   │
└─────────────────────────────────────────────────────────────┘
```
## Module Organization

```
cmd/
└── knowns/
    └── main.go                 # CLI entry point

internal/
├── cli/                        # CLI Command Layer (Cobra)
│   ├── root.go                # Root command + global flags
│   ├── task.go                # Task CRUD (most complex)
│   ├── doc.go                 # Document management
│   ├── time.go                # Time tracking
│   ├── search.go              # Full-text search
│   ├── browser.go             # Web UI launcher
│   ├── config.go              # Configuration
│   ├── init.go                # Project initialization
│   ├── board.go               # Kanban commands
│   └── agents.go              # AI agent coordination
│
├── models/                     # Domain Models
│   ├── task.go                # Task struct + helpers
│   ├── project.go             # Project configuration
│   └── version.go             # Version history
│
├── storage/                    # Persistence Layer
│   ├── file_store.go          # Main storage implementation
│   ├── markdown.go            # Parsing + serialization
│   └── version_store.go       # Version history
│
├── server/                     # Web Server & API (Chi)
│   ├── server.go              # HTTP server + WebSocket
│   └── routes/
│       ├── tasks.go           # Task endpoints
│       ├── docs.go            # Doc endpoints
│       ├── events.go          # SSE/WebSocket endpoint
│       └── ...
│
├── mcp/                        # Model Context Protocol (mcp-go)
│   ├── server.go              # MCP server setup
│   └── handlers/              # Tool handlers
│       ├── task.go
│       ├── doc.go
│       └── ...
│
├── search/                     # Search Engine
│   ├── engine.go              # Search implementation
│   ├── chunker.go             # Text chunking
│   └── store.go               # Index storage
│
├── codegen/                    # Code Generation (Templates)
│   ├── engine.go
│   ├── renderer.go
│   └── parser.go
│
└── util/                       # Shared Utilities
    ├── mention_refs.go        # Reference transformation
    ├── doc_links.go           # Doc link resolution
    └── notify_server.go       # Server notifications

ui/                             # React Web UI (embedded via go:embed)
├── src/
│   ├── App.tsx
│   ├── components/
│   ├── contexts/
│   │   └── SSEContext.tsx     # Real-time event handling
│   ├── pages/
│   └── api/
└── dist/                       # Built assets (embedded into binary)
```
## Key Patterns

### 1. Command Pattern
- Location: `internal/cli/`
- Each command is a `cobra.Command` registered via `init()`
- Uses Cobra for parsing, Lipgloss/Bubbletea for styling
- Details: @doc/architecture/patterns/command

### 2. MCP Server Pattern
- Location: `internal/mcp/`
- JSON-RPC over stdio via mcp-go
- Exposes tools for AI agents
- Details: @doc/architecture/patterns/mcp-server

### 3. File-Based Storage Pattern
- Location: `internal/storage/`
- Markdown + YAML Frontmatter
- Git-friendly, human-readable
- Details: @doc/architecture/patterns/storage

### 4. Real-time Server Pattern
- Location: `internal/server/`
- Chi REST API + Gorilla WebSocket
- Multi-client sync via WebSocket/SSE
- Details: @doc/architecture/patterns/server

### 5. React UI Pattern
- Location: `ui/`
- React 19 + Radix UI, embedded into Go binary via go:embed
- Hooks + Context state management
- Details: @doc/architecture/patterns/ui
## Data Flow

### CLI -> FileStore -> Files

```
User: knowns task create "Title"
       │
       ▼
CLI Parser (Cobra)
       │
       ▼
Command Handler (cli/task.go)
       │
       ▼
FileStore.CreateTask()
       │
       ▼
Write to .knowns/tasks/task-X.md
       │
       ▼
notifyServer("task-created")
       │
       ▼
WebSocket broadcast to browsers
```

### MCP -> Claude Integration

```
Claude Desktop
       │
       ▼ (JSON-RPC over stdio)
MCP Server (mcp/server.go)
       │
       ▼
Tool Handler (e.g., handlers/task.go)
       │
       ▼
FileStore.GetTask()
       │
       ▼
Return task + linked docs to Claude
```

### Browser -> Server -> FileStore

```
Browser (React)
       │
       ▼ (HTTP + WebSocket)
Chi Server
       │
       ▼
REST API Handler (routes/*.go)
       │
       ▼
FileStore operations
       │
       ▼
Broadcast changes via WebSocket
```
## Design Philosophy

### 1. CLI-First
- CLI is the primary interface
- Web UI is secondary (optional, embedded in binary)
- AI integration via MCP
- Single binary distribution (no runtime dependencies)

### 2. Local-First
- Data stored locally (.knowns/)
- No cloud requirement
- Git-friendly

### 3. AI-Ready
- MCP server for Claude (via mcp-go)
- Reference system for context
- Plain output mode for AI agents

### 4. File-Based Storage
- Markdown is the database
- Human-readable
- No migrations needed

### 5. Multi-Access
- CLI, Web UI, MCP can run simultaneously
- Real-time sync via WebSocket
- Single source of truth: files
## Extension Points

### Adding a New Command
1. Create file in `internal/cli/` (e.g., `internal/cli/mycommand.go`)
2. Define a `cobra.Command` struct with Use, Short, Long, RunE fields
3. Register the command via `init()` using `rootCmd.AddCommand(myCmd)`

### Adding a New MCP Tool
1. Create handler file in `internal/mcp/handlers/` (e.g., `handlers/mytool.go`)
2. Define the tool schema (name, description, input parameters)
3. Register the handler in `internal/mcp/server.go`

### Adding a New API Endpoint
1. Create route file in `internal/server/routes/` (e.g., `routes/myroute.go`)
2. Define handler functions using Chi router patterns
3. Register routes in `internal/server/server.go`
4. Broadcast changes via WebSocket if needed

### Adding a New UI Component
1. Create in `ui/src/components/`
2. Use primitives from shadcn/ui
3. Import into pages
4. Rebuild UI with `make ui-build` (assets embedded into binary)
## Related Documentation

| Pattern | Description | Location |
|---------|-------------|----------|
| Command | CLI architecture | @doc/architecture/patterns/command |
| MCP Server | AI integration | @doc/architecture/patterns/mcp-server |
| Storage | File-based persistence | @doc/architecture/patterns/storage |
| Server | REST + SSE | @doc/architecture/patterns/server |
| UI | React components | @doc/architecture/patterns/ui |
