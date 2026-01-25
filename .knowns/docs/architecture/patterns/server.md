---
title: Server Pattern
createdAt: '2025-12-29T07:04:39.771Z'
updatedAt: '2026-01-05T16:58:54.281Z'
description: Documentation for Express + SSE real-time server architecture
tags:
  - architecture
  - patterns
  - server
  - sse
---
## Overview

Knowns server uses Express 5 + SSE (Server-Sent Events) to provide an API for the Web UI and real-time synchronization between clients.

## Location

```
src/server/
├── index.ts              # Server setup, static files
├── routes/
│   ├── index.ts          # Route aggregator
│   ├── events.ts         # SSE endpoint for real-time updates
│   ├── tasks.ts          # Task CRUD routes
│   ├── docs.ts           # Documentation routes
│   ├── config.ts         # Config routes
│   ├── search.ts         # Search routes
│   ├── activities.ts     # Activities routes
│   ├── notify.ts         # CLI notification routes
│   └── time.ts           # Time tracking routes
├── middleware/
│   └── error-handler.ts  # Centralized error handling
└── utils/
    └── markdown.ts       # Helper functions
```

## Architecture

```
┌────────────┐ HTTP/REST    ┌─────────────────────────────────┐
│ Browser    │─────────────►│                                 │
│ Tab 1      │              │         Express Server          │
│            │◄─────────────│                                 │
└────────────┘     SSE      │   ┌─────────────────────────┐   │
                            │   │     Route Modules       │   │
┌────────────┐ HTTP/REST    │   │  ┌─────┐ ┌─────┐       │   │
│ Browser    │─────────────►│   │  │tasks│ │docs │       │   │
│ Tab 2      │              │   │  └─────┘ └─────┘       │   │
│            │◄─────────────│   │  ┌──────┐ ┌──────┐     │   │
└────────────┘     SSE      │   │  │config│ │search│     │   │
                            │   │  └──────┘ └──────┘     │   │
┌────────────┐              │   │  ┌────┐ ┌────────┐     │   │
│   CLI      │──POST───────►│   │  │time│ │notify  │     │   │
│            │  /notify     │   │  └────┘ └────────┘     │   │
└────────────┘              │   └─────────────────────────┘   │
                            │                                 │
                            │   ┌─────────────────────────┐   │
                            │   │   SSE Events Endpoint   │   │
                            │   │   /api/events           │   │
                            │   │   - Single connection   │   │
                            │   │   - Auto-reconnect      │   │
                            │   │   - Broadcast changes   │   │
                            │   └─────────────────────────┘   │
                            │                                 │
                            │   ┌─────────────────────────┐   │
                            │   │      FileStore          │   │
                            │   │   Read/Write .knowns/   │   │
                            │   └─────────────────────────┘   │
                            └─────────────────────────────────┘
```

## SSE vs WebSocket

We chose SSE over WebSocket because:

| Feature | SSE | WebSocket |
|---------|-----|-----------|
| **Communication** | Server → Client (unidirectional) | Bidirectional |
| **Reconnection** | Built-in automatic | Manual implementation |
| **Protocol** | Standard HTTP/HTTPS | Custom ws:// protocol |
| **Firewall** | Firewall friendly | May be blocked |
| **Dependencies** | Native browser API | Requires `ws` library |

Since our use case only requires server-to-client updates (broadcasts), SSE is simpler and more reliable.

## SSE Implementation

### Server-Side (routes/events.ts)

```typescript
import { type Request, type Response, Router } from "express";

// Track connected SSE clients
const clients = new Set<Response>();

// Broadcast event to all connected clients
export function broadcast(event: string, data: object): void {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(message);
  }
}

// SSE endpoint
router.get("/", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  clients.add(res);
  req.on("close", () => clients.delete(res));
});
```

### Client-Side (SSEContext.tsx)

```typescript
// Single SSE connection per browser tab
const eventSource = new EventSource("/api/events");

// Listen for specific event types
eventSource.addEventListener("tasks:updated", (e) => {
  const data = JSON.parse(e.data);
  // Handle task update
});

// EventSource auto-reconnects on connection loss
```

## SSE Events

| Event | Payload | Description |
|-------|---------|-------------|
| `connected` | `{ timestamp }` | Connection established |
| `tasks:updated` | `{ task }` | Task created/updated |
| `tasks:refresh` | - | Reload all tasks |
| `tasks:archived` | `{ task }` | Task archived |
| `tasks:unarchived` | `{ task }` | Task unarchived |
| `time:updated` | `{ active }` | Timer state changed |
| `docs:updated` | `{ docPath }` | Doc updated |
| `docs:refresh` | - | Reload all docs |

## Route Context Pattern

All route modules receive a shared context:

```typescript
interface RouteContext {
  store: FileStore;
  broadcast: (data: { type: string; [key: string]: unknown }) => void;
}
```

## API Endpoints Summary

| Module | Method | Endpoint | Description |
|--------|--------|----------|-------------|
| events | GET | `/api/events` | SSE stream |
| tasks | GET | `/api/tasks` | List all tasks |
| tasks | GET | `/api/tasks/:id` | Get single task |
| tasks | POST | `/api/tasks` | Create task |
| tasks | PUT | `/api/tasks/:id` | Update task |
| docs | GET | `/api/docs` | List all docs |
| docs | GET | `/api/docs/:path` | Get single doc |
| config | GET | `/api/config` | Get project config |
| search | GET | `/api/search` | Search tasks & docs |
| time | GET | `/api/time/status` | Get active timer |
| time | POST | `/api/time/start` | Start timer |
| time | POST | `/api/time/stop` | Stop timer |
| notify | POST | `/api/notify` | CLI notification |

## Related Docs

- @doc/architecture/patterns/storage - File-Based Storage Pattern
- @doc/architecture/patterns/ui - React UI Pattern
- @doc/architecture/patterns/command - CLI Command Pattern
