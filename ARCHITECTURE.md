# Architecture

Technical overview of how Knowns is built.

For design principles, see [PHILOSOPHY.md](./PHILOSOPHY.md).

---

## Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         User Layer                               │
├─────────────┬─────────────┬─────────────┬──────────────────────┤
│     CLI     │   Web UI    │  MCP Server │    AI Agents         │
│  (primary)  │  (visual)   │  (Claude)   │  (consumers)         │
└──────┬──────┴──────┬──────┴──────┬──────┴──────────┬───────────┘
       │             │             │                 │
       ▼             ▼             ▼                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Command Layer                               │
│  task.ts │ doc.ts │ time.ts │ search.ts │ browser.ts │ mcp.ts  │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Storage Layer                               │
│         file-store.ts  │  version-store.ts  │  config.ts        │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      File System                                 │
│                        .knowns/                                  │
│     tasks/  │  docs/  │  config.json  │  .timer  │  .versions   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Core Principles

### 1. Files as Database

No SQLite. No JSON database. Just markdown files.

```
.knowns/
├── config.json           # Project configuration
├── tasks/
│   ├── task-1 - Title.md
│   └── task-2 - Title.md
├── docs/
│   ├── patterns/
│   │   └── auth.md
│   └── architecture/
│       └── overview.md
└── .versions/            # Version history (hidden)
```

**Why:** Portable, debuggable, Git-friendly, survives tool changes.

### 2. Markdown + Frontmatter

Every file follows the same pattern:

```markdown
---
id: "42"
title: "Add authentication"
status: "in-progress"
priority: "high"
createdAt: "2025-01-15T10:00:00Z"
updatedAt: "2025-01-15T14:30:00Z"
---

## Description

Content here...
```

**Why:** Human-readable, machine-parseable, standard format.

### 3. Reference Resolution

References like `@doc/patterns/auth` resolve to real file paths:

```
Input:  @doc/patterns/auth
Output: .knowns/docs/patterns/auth.md

Input:  @task-42
Output: .knowns/tasks/task-42 - Title.md
```

**Why:** Deterministic, no magic, AI can follow links.

---

## Directory Structure

```
src/
├── index.ts              # CLI entry point
├── commands/             # CLI commands
│   ├── task.ts           # knowns task *
│   ├── doc.ts            # knowns doc *
│   ├── time.ts           # knowns time *
│   ├── search.ts         # knowns search
│   ├── browser.ts        # knowns browser
│   └── agents.ts         # knowns agents
├── models/               # Domain models
│   ├── task.ts           # Task entity
│   └── doc.ts            # Document entity
├── storage/              # Persistence layer
│   ├── file-store.ts     # File operations
│   ├── version-store.ts  # Version history
│   └── paths.ts          # Path resolution
├── server/               # Web UI backend
│   └── index.ts          # Express + WebSocket
├── mcp/                  # MCP server
│   └── server.ts         # Claude integration
├── ui/                   # React frontend
│   ├── App.tsx
│   └── components/
└── utils/                # Shared utilities
    ├── markdown.ts       # Markdown parsing
    ├── mention-refs.ts   # Reference resolution
    └── formatting.ts     # Output formatting
```

---

## Data Flow

### CLI Command

```
User: knowns task view 42 --plain

1. CLI parses command (commander.js)
2. Command calls storage layer
3. Storage reads .knowns/tasks/task-42 - *.md
4. Markdown parsed, frontmatter extracted
5. Output formatted (plain text for AI)
6. Result printed to stdout
```

### Web UI

```
User: Opens browser, views task

1. knowns browser starts Express server
2. React app loads in browser
3. App fetches GET /api/tasks/42
4. Server reads file, returns JSON
5. React renders task details
6. WebSocket notifies other clients on changes
```

### MCP Server

```
AI: Requests task via MCP

1. Claude calls list_tasks or get_task tool
2. MCP server receives request
3. Server reads files from .knowns/
4. Returns structured data to Claude
5. Claude uses context for implementation
```

---

## Real-time Sync (Web UI)

```
┌─────────┐     WebSocket      ┌─────────┐
│ Browser │◄──────────────────►│ Server  │
│   Tab 1 │                    │         │
└─────────┘                    │         │
                               │         │
┌─────────┐     WebSocket      │         │
│ Browser │◄──────────────────►│         │
│   Tab 2 │                    │         │
└─────────┘                    │         │
                               │         │
┌─────────┐   CLI + notify     │         │
│   CLI   │───────────────────►│         │
└─────────┘                    └─────────┘
```

When CLI modifies a task:
1. CLI writes to file
2. CLI calls POST /api/notify
3. Server broadcasts to all WebSocket clients
4. Browsers update in real-time

---

## Self-Hosted Sync (Planned)

```
┌─────────────────────────────────────────────────────────────────┐
│                        Team Network                              │
│                                                                  │
│  ┌─────────┐      ┌─────────┐      ┌─────────┐                 │
│  │ Dev A   │      │ Dev B   │      │ Dev C   │                 │
│  │.knowns/ │      │.knowns/ │      │.knowns/ │                 │
│  └────┬────┘      └────┬────┘      └────┬────┘                 │
│       │                │                │                       │
│       └────────────────┼────────────────┘                       │
│                        │                                         │
│                        ▼                                         │
│              ┌─────────────────┐                                │
│              │   Sync Server   │                                │
│              │  (self-hosted)  │                                │
│              │                 │                                │
│              │ • Task mirror   │                                │
│              │ • Activity feed │                                │
│              │ • Team dashboard│                                │
│              └─────────────────┘                                │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Sync Logic:**

```
1. Local .knowns/ is always source of truth
2. CLI pushes changes to sync server
3. Server stores latest state + history
4. Team members can view (read-only) or pull
5. Conflicts resolved by timestamp (last-write-wins) or manual merge
```

**What syncs:**
- Task metadata and content
- Document metadata and content
- Activity log (who changed what, when)

**What stays local:**
- Timer state
- Local configuration
- Uncommitted drafts

---

## Technology Stack

| Layer | Technology |
|-------|------------|
| CLI | TypeScript, Commander.js |
| Storage | File system, gray-matter (frontmatter) |
| Web Server | Express 5, WebSocket (ws) |
| Web UI | React 19, Vite, TailwindCSS |
| MCP | @modelcontextprotocol/sdk |
| Build | esbuild (CLI), Vite (UI) |
| Test | Vitest |
| Lint | Biome |

---

## Key Design Decisions

### Why Express over Bun.serve?

Node.js compatibility. Knowns should run anywhere Node runs, not just Bun.

### Why no database?

- Files are simpler to debug
- Git provides version control for free
- No migration headaches
- Portable across machines

### Why markdown?

- Human-readable without tools
- Syntax highlighting everywhere
- Frontmatter for structured data
- Easy to parse programmatically

### Why WebSocket for sync?

- Real-time updates without polling
- Low latency for collaborative editing
- Simple pub/sub model

---

## Extension Points

### Adding a new command

1. Create `src/commands/mycommand.ts`
2. Export command function
3. Register in `src/index.ts`

### Adding a new MCP tool

1. Edit `src/mcp/server.ts`
2. Add tool definition
3. Add handler function

### Adding a new API endpoint

1. Edit `src/server/index.ts`
2. Add route handler
3. Update WebSocket broadcast if needed

---

## Security Considerations

- **Local-first:** Data never leaves your machine unless you enable sync
- **No auth by default:** Web UI is localhost-only
- **Sync server:** Will require authentication when implemented
- **File permissions:** Respect OS file permissions

---

## Performance

- **File reads:** Cached in memory during server lifetime
- **Search:** Full-text scan (fast enough for typical project sizes)
- **WebSocket:** Lightweight JSON messages
- **Startup:** < 100ms for CLI commands

For very large projects (1000+ tasks), consider pagination or indexing.
