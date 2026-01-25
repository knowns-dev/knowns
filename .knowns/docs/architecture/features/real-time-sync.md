---
title: Real-time Sync
createdAt: '2026-01-05T16:59:43.560Z'
updatedAt: '2026-01-05T16:59:58.794Z'
description: Documentation for SSE-based real-time synchronization
tags:
  - feature
  - sse
  - sync
---
## Overview

Knowns uses Server-Sent Events (SSE) for real-time synchronization between CLI, Web UI, and multiple browser tabs.

## How It Works

```
CLI Command → FileStore → Notify Server → SSE Broadcast → All Browser Tabs
```

When you run a CLI command (e.g., `knowns task edit 42 -s done`), the change:
1. Is written to disk by FileStore
2. Triggers a notification to the server
3. Gets broadcast to all connected browser tabs via SSE

## SSE Events

| Event | Description |
|-------|-------------|
| `connected` | Connection established |
| `tasks:updated` | Task created or modified |
| `tasks:refresh` | Reload all tasks |
| `time:updated` | Timer state changed |
| `docs:updated` | Document updated |
| `docs:refresh` | Reload all docs |

## Auto-Reconnection

SSE automatically reconnects when:
- Network connection is restored
- Computer wakes from sleep
- Server restarts

On reconnection, the UI automatically refreshes all data to ensure consistency.

### Implementation

The `SSEContext` tracks connection state and triggers refresh events on reconnect:

```typescript
// When SSE reconnects after being connected before
if (wasConnectedRef.current) {
  emit("tasks:refresh", {});
  emit("time:refresh", {});
  emit("docs:refresh", {});
}
```

## Why SSE over WebSocket?

| Feature | SSE | WebSocket |
|---------|-----|-----------|
| Communication | Server → Client | Bidirectional |
| Reconnection | Built-in auto | Manual impl |
| Protocol | Standard HTTP | Custom ws:// |
| Firewall | Friendly | May be blocked |

Since our use case only needs server-to-client push, SSE is simpler and more reliable.

## Related

- @doc/architecture/patterns/server - Server architecture details
- @doc/architecture/patterns/ui - React UI patterns
