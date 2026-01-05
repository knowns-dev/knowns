---
title: Architecture Overview
createdAt: '2025-12-29T07:06:54.131Z'
updatedAt: '2026-01-05T16:25:51.965Z'
description: High-level overview of Knowns architecture and how patterns connect
tags:
  - architecture
  - overview
---
## Overview

Knowns is a CLI-first knowledge layer and task management system for development teams. Designed to maintain persistent project context for AI assistance.

**Tagline**: "Know what your team knows."

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Bun / Node.js |
| Language | TypeScript 5.7 |
| CLI | Commander.js |
| Server | Express 5 + SSE (Server-Sent Events) |
| Web UI | React 19 + Vite + TailwindCSS 4 |
| UI Components | Radix UI (shadcn/ui) |
| Storage | File-based (Markdown + YAML Frontmatter) |
| AI Integration | Model Context Protocol (MCP) |
| Testing | Vitest |
| Linting | Biome |

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
│  task.ts | doc.ts | time.ts | search.ts | browser.ts | ...  │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                Storage & Service Layer                       │
│      FileStore | VersionStore | AIService | Markdown         │
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
src/
├── index.ts                    # CLI entry point
├── commands/                   # CLI Command Pattern
│   ├── task.ts                # Task CRUD (most complex)
│   ├── doc.ts                 # Document management
│   ├── time.ts                # Time tracking
│   ├── search.ts              # Full-text search
│   ├── browser.ts             # Web UI launcher
│   ├── config.ts              # Configuration
│   ├── init.ts                # Project initialization
│   ├── board.ts               # Kanban commands
│   └── agents.ts              # AI agent coordination
│
├── models/                     # Domain Models (DDD)
│   ├── task.ts                # Task interface + helpers
│   ├── project.ts             # Project configuration
│   └── version.ts             # Version history
│
├── storage/                    # Persistence Layer
│   ├── file-store.ts          # Main storage class
│   ├── markdown.ts            # Parsing + serialization
│   └── version-store.ts       # Version history
│
├── server/                     # Web Server & API
│   ├── index.ts               # Express server
│   └── routes/
│       └── events.ts          # SSE endpoint
│
├── mcp/                        # Model Context Protocol
│   └── server.ts              # Claude integration
│
├── services/                   # Business Logic
│   └── ai-service.ts          # AI-assisted features
│
├── ui/                         # React Web UI (SPA)
│   ├── App.tsx
│   ├── components/
│   ├── contexts/
│   │   └── SSEContext.tsx     # Real-time event handling
│   ├── pages/
│   └── api/
│
└── utils/                      # Shared Utilities
    ├── mention-refs.ts        # Reference transformation
    ├── doc-links.ts           # Doc link resolution
    └── notify-server.ts       # Server notifications
```

## Key Patterns

### 1. Command Pattern
- Location: `src/commands/`
- Each command is an independent module
- Uses Commander.js
- Details: @doc/patterns/command-pattern

### 2. MCP Server Pattern
- Location: `src/mcp/server.ts`
- JSON-RPC over stdio
- Exposes tools for AI
- Details: @doc/patterns/mcp-server-pattern

### 3. File-Based Storage Pattern
- Location: `src/storage/`
- Markdown + YAML Frontmatter
- Git-friendly, human-readable
- Details: @doc/patterns/storage-pattern

### 4. Real-time Server Pattern
- Location: `src/server/index.ts`
- Express REST API + SSE
- Multi-client sync via EventSource
- Details: @doc/patterns/server-pattern

### 5. React UI Pattern
- Location: `src/ui/`
- React 19 + Radix UI
- Hooks + Context state management
- Details: @doc/patterns/ui-pattern

## Data Flow

### CLI -> FileStore -> Files

```
User: knowns task create "Title"
       │
       ▼
CLI Parser (Commander.js)
       │
       ▼
Command Handler (task.ts)
       │
       ▼
FileStore.createTask()
       │
       ▼
Write to .knowns/tasks/task-X.md
       │
       ▼
notifyServer("task-created")
       │
       ▼
SSE broadcast to browsers
```

### MCP -> Claude Integration

```
Claude Desktop
       │
       ▼ (JSON-RPC over stdio)
MCP Server (server.ts)
       │
       ▼
Tool Handler (e.g., get_task)
       │
       ▼
FileStore.getTask()
       │
       ▼
Return task + linked docs to Claude
```

### Browser -> Server -> FileStore

```
Browser (React)
       │
       ▼ (HTTP + SSE)
Express Server
       │
       ▼
REST API Handler
       │
       ▼
FileStore operations
       │
       ▼
Broadcast changes via SSE
```

## Design Philosophy

### 1. CLI-First
- CLI is the primary interface
- Web UI is secondary (optional)
- AI integration via MCP

### 2. Local-First
- Data stored locally (.knowns/)
- No cloud requirement
- Git-friendly

### 3. AI-Ready
- MCP server for Claude
- Reference system for context
- Plain output mode for AI agents

### 4. File-Based Storage
- Markdown is the database
- Human-readable
- No migrations needed

### 5. Multi-Access
- CLI, Web UI, MCP can run simultaneously
- Real-time sync via SSE
- Single source of truth: files

## Extension Points

### Adding a New Command
1. Create file in `src/commands/`
2. Export from `src/commands/index.ts`
3. Register in `src/index.ts`

### Adding a New MCP Tool
1. Define Zod schema
2. Register in ListToolsRequestSchema handler
3. Add handler case in CallToolRequestSchema

### Adding a New API Endpoint
1. Edit `src/server/routes/`
2. Add route module
3. Register in `routes/index.ts`
4. Broadcast changes via SSE

### Adding a New UI Component
1. Create in `src/ui/components/`
2. Use primitives from `ui/` folder
3. Import into pages

## Related Documentation

| Pattern | Description | Location |
|---------|-------------|----------|
| Command | CLI architecture | @doc/patterns/command-pattern |
| MCP Server | AI integration | @doc/patterns/mcp-server-pattern |
| Storage | File-based persistence | @doc/patterns/storage-pattern |
| Server | REST + SSE | @doc/patterns/server-pattern |
| UI | React components | @doc/patterns/ui-pattern |
