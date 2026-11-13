---
id: doc-84612469f9569c74c57ef6a1f5e24d42
title: Server Pattern
createdAt: '2025-12-29T07:04:39.771Z'
updatedAt: '2026-03-09T06:40:13.337Z'
description: Documentation for Go chi + SSE real-time server architecture
tags:
  - architecture
  - patterns
  - server
  - sse
---
## Overview

Knowns server is written in Go using **chi router** + **SSE (Server-Sent Events)** + **WebSocket** to provide a REST API for the Web UI, real-time synchronization between clients, and terminal streaming for workspaces.

## Location

```
internal/server/
├── server.go                 # Server setup, chi router, middleware, static UI
├── sse.go                    # SSE broker (client registry, broadcast)
├── routes/
│   ├── router.go             # Route aggregator (SetupRoutes)
│   ├── broker.go             # Broadcaster interface + SSEEvent type
│   ├── helpers.go            # respondJSON, respondError, decodeJSON
│   ├── tasks.go              # Task CRUD routes
│   ├── docs.go               # Documentation routes
│   ├── config.go             # Config routes
│   ├── search.go             # Search routes
│   ├── time.go               # Time tracking routes
│   ├── templates.go          # Template routes
│   ├── validate.go           # Validation / SDD routes
│   ├── notify.go             # CLI → Server notification relay
│   ├── activities.go         # Activity log routes
│   ├── workspaces.go         # Workspace orchestration routes
│   └── imports.go            # Import management routes
└── workspace/
    ├── orchestrator.go       # Phase-based workspace execution
    ├── manager.go            # Worktree lifecycle management
    ├── process.go            # Process manager (spawn, attach WS)
    ├── agents.go             # Agent CLI detection (claude, codex, etc.)
    └── prompt_generator.go   # Task-to-prompt generation
```

## Architecture

```
┌────────────┐ HTTP/REST    ┌─────────────────────────────────────┐
│ Browser    │─────────────►│                                     │
│ Tab 1      │              │     Go HTTP Server (chi router)     │
│            │◄─────────────│                                     │
└────────────┘     SSE      │   ┌─────────────────────────────┐   │
                            │   │       Route Modules         │   │
┌────────────┐ HTTP/REST    │   │  ┌─────┐ ┌─────┐ ┌──────┐  │   │
│ Browser    │─────────────►│   │  │tasks│ │docs │ │config│  │   │
│ Tab 2      │              │   │  └─────┘ └─────┘ └──────┘  │   │
│            │◄─────────────│   │  ┌──────┐ ┌────┐ ┌─────┐   │   │
└────────────┘     SSE      │   │  │search│ │time│ │templ│   │   │
                            │   │  └──────┘ └────┘ └─────┘   │   │
┌────────────┐              │   │  ┌────────┐ ┌──────────┐   │   │
│   CLI      │──POST───────►│   │  │notify  │ │workspaces│   │   │
│            │  /notify     │   │  └────────┘ └──────────┘   │   │
└────────────┘              │   │  ┌────────┐ ┌──────────┐   │   │
                            │   │  │imports │ │validate  │   │   │
┌────────────┐ WebSocket    │   │  └────────┘ └──────────┘   │   │
│ Terminal   │◄────────────►│   └─────────────────────────────┘   │
│ UI         │  /ws/terminal│                                     │
└────────────┘              │   ┌─────────────────────────────┐   │
                            │   │   SSE Broker                │   │
                            │   │   /api/events               │   │
                            │   │   - Client registry (map)   │   │
                            │   │   - Buffered channels       │   │
                            │   │   - Broadcast to all        │   │
                            │   └─────────────────────────────┘   │
                            │                                     │
                            │   ┌─────────────────────────────┐   │
                            │   │      storage.Store          │   │
                            │   │   Read/Write .knowns/       │   │
                            │   └─────────────────────────────┘   │
                            └─────────────────────────────────────┘
```

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `github.com/go-chi/chi/v5` | Lightweight HTTP router with middleware |
| `github.com/go-chi/chi/v5/middleware` | Recoverer, RequestID, RealIP, Logger |
| `github.com/rs/cors` | CORS handling |
| `github.com/gorilla/websocket` | WebSocket for terminal streaming |

## SSE vs WebSocket

We use SSE for data synchronization and WebSocket for terminal streaming:

| Feature | SSE | WebSocket |
|---------|-----|-----------| 
| **Communication** | Server to Client (unidirectional) | Bidirectional |
| **Reconnection** | Built-in automatic | Manual implementation |
| **Protocol** | Standard HTTP/HTTPS | Custom ws:// protocol |
| **Firewall** | Firewall friendly | May be blocked |
| **Dependencies** | Native browser API | Requires gorilla/websocket |
| **Use case** | Data change broadcasts | Terminal I/O streaming |

SSE handles all data synchronization (task updates, doc changes, timer events). WebSocket is used exclusively for the workspace terminal, where bidirectional communication is needed to stream process output and accept stdin input.

## SSE Implementation

### Broker (sse.go)

```go
// SSEBroker manages SSE client connections and broadcasts events.
// It implements routes.Broadcaster so route handlers can emit events
// without importing the server package (avoiding circular deps).
type SSEBroker struct {
    clients map[chan routes.SSEEvent]struct{}
    mu      sync.RWMutex
}

// Subscribe handles an incoming SSE request. It registers the client,
// streams events until the connection closes, and then deregisters.
func (b *SSEBroker) Subscribe(w http.ResponseWriter, r *http.Request) {
    flusher, ok := w.(http.Flusher)
    if !ok {
        http.Error(w, "streaming unsupported", http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "text/event-stream")
    w.Header().Set("Cache-Control", "no-cache")
    w.Header().Set("Connection", "keep-alive")
    w.Header().Set("X-Accel-Buffering", "no")

    ch := make(chan routes.SSEEvent, 64)

    b.mu.Lock()
    b.clients[ch] = struct{}{}
    b.mu.Unlock()

    defer func() {
        b.mu.Lock()
        delete(b.clients, ch)
        b.mu.Unlock()
        close(ch)
    }()

    // Send initial "connected" event.
    fmt.Fprintf(w, "data: {\"type\":\"connected\"}

")
    flusher.Flush()

    ctx := r.Context()
    for {
        select {
        case <-ctx.Done():
            return
        case evt, open := <-ch:
            if !open {
                return
            }
            payload, _ := json.Marshal(evt)
            fmt.Fprintf(w, "data: %s

", payload)
            flusher.Flush()
        }
    }
}

// Broadcast sends an event to every subscribed client.
func (b *SSEBroker) Broadcast(event routes.SSEEvent) {
    b.mu.RLock()
    defer b.mu.RUnlock()
    for ch := range b.clients {
        select {
        case ch <- event:
        default:
            // Drop if channel full to avoid blocking.
        }
    }
}
```

### Broadcaster Interface (routes/broker.go)

```go
// SSEEvent is the event payload broadcast to SSE clients.
type SSEEvent struct {
    Type string      `json:"type"`
    Data interface{} `json:"data"`
}

// Broadcaster is implemented by server.SSEBroker.
// Route handlers use this interface to emit events without
// importing the server package (prevents circular dependency).
type Broadcaster interface {
    Broadcast(event SSEEvent)
}
```

### Client-Side (SSEContext.tsx)

```typescript
// Single SSE connection per browser tab
const eventSource = new EventSource("/api/events");

// Listen for specific event types
eventSource.addEventListener("message", (e) => {
  const data = JSON.parse(e.data);
  // Handle based on data.type
});

// EventSource auto-reconnects on connection loss
```

## SSE Events

| Event | Payload | Description |
|-------|---------|-------------|
| `connected` | `{ type }` | Connection established |
| `tasks:updated` | `{ id }` | Task created/updated |
| `tasks:archived` | `{ id }` | Task archived |
| `tasks:unarchived` | `{ id }` | Task unarchived |
| `tasks:batch-archived` | `{ count }` | Batch archive completed |
| `tasks:reordered` | `{ updated }` | Task order changed |
| `time:updated` | `{ active }` | Timer state changed |
| `docs:updated` | `{ path }` | Doc updated |
| `templates:created` | `{ name }` | Template created |
| `workspaces:created` | `{ id }` | Workspace created |
| `workspaces:updated` | `{ workspace }` | Workspace state changed |
| `workspaces:deleted` | `{ workspaceId }` | Workspace removed |
| `imports:synced` | `{ name }` | Import synced |
| `refresh` | `{ full }` | Full client refresh |

## Route Module Pattern

Each route module is a struct that holds `*storage.Store` and optionally `Broadcaster`, then registers its handlers onto a `chi.Router`:

```go
// TaskRoutes handles /api/tasks endpoints.
type TaskRoutes struct {
    store *storage.Store
    sse   Broadcaster
}

// Register wires the task routes onto r.
func (tr *TaskRoutes) Register(r chi.Router) {
    r.Get("/tasks", tr.list)
    r.Post("/tasks", tr.create)
    r.Get("/tasks/{id}", tr.get)
    r.Put("/tasks/{id}", tr.update)
    r.Post("/tasks/{id}/archive", tr.archive)
}
```

All modules are wired together in `routes/router.go`:

```go
func SetupRoutes(r chi.Router, store *storage.Store, sse Broadcaster, orchestrator *workspace.PhaseOrchestrator) {
    tr := &TaskRoutes{store: store, sse: sse}
    tr.Register(r)

    dr := &DocRoutes{store: store, sse: sse}
    dr.Register(r)

    // ... config, time, search, templates, validate,
    //     notify, workspaces, imports, activities
}
```

### Response Helpers (routes/helpers.go)

```go
// respondJSON writes status and JSON-encodes data to the response.
func respondJSON(w http.ResponseWriter, status int, data interface{}) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    if data != nil {
        _ = json.NewEncoder(w).Encode(data)
    }
}

// respondError writes a JSON error body with the given HTTP status code.
func respondError(w http.ResponseWriter, status int, message string) {
    respondJSON(w, status, map[string]string{"error": message})
}

// decodeJSON reads and JSON-decodes the request body into v.
func decodeJSON(r *http.Request, v interface{}) error {
    defer r.Body.Close()
    return json.NewDecoder(r.Body).Decode(v)
}
```

## Server Initialization

```go
func NewServer(store *storage.Store, projectRoot string, port int) *Server {
    processManager := workspace.NewProcessManager()
    worktreeManager := workspace.NewWorktreeManager(projectRoot)
    orchestrator := workspace.NewPhaseOrchestrator(store, processManager, worktreeManager, projectRoot)

    s := &Server{
        store:        store,
        sse:          NewSSEBroker(),
        orchestrator: orchestrator,
        port:         port,
        projectRoot:  projectRoot,
    }

    // Wire SSE to orchestrator via adapter.
    orchestrator.SetSSE(&sseAdapter{broker: s.sse})

    // Wire all-phases-complete callback: auto-update linked task to "in-review".
    orchestrator.SetOnAllPhasesComplete(func(ws *models.Workspace, phaseOutputs []string) {
        // ... auto-set task status to in-review
    })

    s.router = s.buildRouter()
    return s
}
```

### Middleware Stack

```go
func (s *Server) buildRouter() chi.Router {
    r := chi.NewRouter()

    r.Use(middleware.Recoverer)   // Panic recovery
    r.Use(middleware.RequestID)   // X-Request-Id header
    r.Use(middleware.RealIP)      // X-Real-IP / X-Forwarded-For
    r.Use(middleware.Logger)      // Request logging

    // CORS: allow all origins for development.
    c := cors.New(cors.Options{
        AllowedOrigins: []string{"*"},
        AllowedMethods: []string{"GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"},
        AllowedHeaders: []string{"Accept", "Authorization", "Content-Type", "X-CSRF-Token"},
    })
    r.Use(c.Handler)

    r.Get("/api/events", s.sse.Subscribe)
    r.Route("/api", func(r chi.Router) {
        routes.SetupRoutes(r, s.store, s.sse, s.orchestrator)
    })
    r.Get("/ws/terminal", s.handleTerminalWS)
    s.mountUI(r)

    return r
}
```

### Static UI Serving

The compiled React UI is embedded using Go's `embed.FS` and served at `/`. All non-API, non-asset paths fall through to `index.html` for SPA client-side routing.

## WebSocket Terminal

Workspaces use WebSocket for bidirectional terminal streaming:

```go
// GET /ws/terminal?workspaceId=xxx
func (s *Server) handleTerminalWS(w http.ResponseWriter, r *http.Request) {
    workspaceID := r.URL.Query().Get("workspaceId")
    conn, err := wsUpgrader.Upgrade(w, r, nil)
    // ...
    pm := s.orchestrator.Processes()
    pm.AttachWS(workspaceID, conn)     // Replay buffer + stream output
    defer pm.DetachWS(workspaceID, conn)

    for {
        _, msg, err := conn.ReadMessage()
        // type=input → write to process stdin
    }
}
```

## API Endpoints Summary

| Module | Method | Endpoint | Description |
|--------|--------|----------|-------------|
| events | GET | `/api/events` | SSE stream |
| tasks | GET | `/api/tasks` | List all tasks |
| tasks | GET | `/api/tasks/{id}` | Get single task |
| tasks | POST | `/api/tasks` | Create task |
| tasks | PUT | `/api/tasks/{id}` | Update task |
| tasks | POST | `/api/tasks/{id}/archive` | Archive task |
| tasks | POST | `/api/tasks/{id}/unarchive` | Unarchive task |
| tasks | POST | `/api/tasks/batch-archive` | Batch archive done tasks |
| tasks | POST | `/api/tasks/reorder` | Reorder tasks |
| tasks | POST | `/api/tasks/sync-spec-acs` | Sync spec ACs |
| tasks | GET | `/api/tasks/{id}/history` | Version history |
| docs | GET | `/api/docs` | List all docs |
| docs | GET | `/api/docs/*` | Get single doc |
| docs | POST | `/api/docs` | Create doc |
| docs | PUT | `/api/docs/*` | Update doc |
| config | GET | `/api/config` | Get project config |
| config | POST | `/api/config` | Save project config |
| search | GET | `/api/search` | Search tasks and docs |
| time | GET | `/api/time/status` | Get active timers |
| time | POST | `/api/time/start` | Start timer |
| time | POST | `/api/time/stop` | Stop timer |
| time | POST | `/api/time/pause` | Pause timer |
| time | POST | `/api/time/resume` | Resume timer |
| templates | GET | `/api/templates` | List templates |
| templates | GET | `/api/templates/{name}` | Get template |
| templates | POST | `/api/templates` | Create template |
| templates | POST | `/api/templates/preview` | Preview render |
| templates | POST | `/api/templates/{name}/run` | Run template |
| validate | GET | `/api/validate/sdd` | SDD validation stats |
| notify | POST | `/api/notify/task/{id}` | Broadcast task update |
| notify | POST | `/api/notify/doc/*` | Broadcast doc update |
| notify | POST | `/api/notify/time` | Broadcast time update |
| notify | POST | `/api/notify/refresh` | Broadcast full refresh |
| workspaces | GET | `/api/workspaces` | List workspaces |
| workspaces | POST | `/api/workspaces` | Create workspace |
| workspaces | GET | `/api/workspaces/{id}` | Get workspace |
| workspaces | POST | `/api/workspaces/from-task` | Create from task |
| workspaces | POST | `/api/workspaces/{id}/start` | Start execution |
| workspaces | POST | `/api/workspaces/{id}/stop` | Stop execution |
| workspaces | POST | `/api/workspaces/{id}/resume` | Resume execution |
| workspaces | POST | `/api/workspaces/{id}/restart` | Restart workspace |
| workspaces | DELETE | `/api/workspaces/{id}` | Delete workspace |
| workspaces | GET | `/api/workspaces/{id}/diff` | Git diff |
| workspaces | POST | `/api/workspaces/{id}/merge` | Merge branch |
| workspaces | GET | `/api/workspaces/agents` | List available agents |
| workspaces | GET | `/api/workspaces/by-task/{taskId}` | Find by task |
| workspaces | GET | `/api/workspaces/prompt-preview/{taskId}` | Preview prompt |
| imports | GET | `/api/imports` | List imports |
| imports | POST | `/api/imports` | Add import |
| imports | GET | `/api/imports/{name}` | Get import details |
| imports | DELETE | `/api/imports/{name}` | Remove import |
| imports | POST | `/api/imports/sync` | Sync imports |
| imports | POST | `/api/imports/{name}/sync` | Sync single import |
| imports | POST | `/api/imports/sync-all` | Sync all imports |
| activities | GET | `/api/activities` | List activities |

## Circular Dependency Prevention

The `routes` package defines the `Broadcaster` interface and `SSEEvent` type locally, while the `server` package provides the concrete `SSEBroker` implementation. This avoids a circular import between `server` and `routes`. The `sseAdapter` struct in `server.go` bridges the `workspace.Broadcaster` interface to `SSEBroker`.

## Related Docs

- @doc/architecture/patterns/storage - File-Based Storage Pattern
- @doc/architecture/patterns/ui - React UI Pattern
- @doc/architecture/patterns/command - CLI Command Pattern
