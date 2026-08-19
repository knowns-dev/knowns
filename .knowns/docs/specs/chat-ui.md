---
id: doc-065bdcda136cfc14f967502a496775f6
title: Chat UI
description: Specification for replacing AI Workspaces with an interactive Chat UI powered by Claude Code / OpenCode CLI sessions
createdAt: '2026-03-12T05:22:27.445Z'
updatedAt: '2026-08-19T10:04:29.038Z'
tags:
  - spec
  - superseded
---

## Overview

Replace the AI Workspaces feature (rigid multi-phase pipeline) with an interactive Chat UI. Users can have multiple chat sessions, each powered by Claude Code or OpenCode CLI underneath. Each message spawns a short-lived process; session continuity is handled by Claude's `--session-id` flag.

UI follows BeeBot/Notion AI pattern: sidebar with chat history grouped by time, model selector dropdown, welcome screen, and chat input.

## Requirements

### Functional Requirements

- FR-1: Multiple chat sessions — users can create, switch between, rename, and delete chat sessions
- FR-2: Two agent systems supported — Claude and OpenCode only (remove Codex)
- FR-3: Agent type locked per session — once created as Claude or OpenCode, cannot switch to the other
- FR-4: Model switchable within same agent — e.g. switch from sonnet to opus mid-conversation
- FR-5: Each message spawns a new CLI process with `--session-id` for context continuity
- FR-6: Real-time streaming — assistant responses stream via WebSocket as they generate
- FR-7: Message history persisted — user and assistant messages stored as summaries in `.knowns/chats.json`
- FR-8: Chat sidebar — sessions grouped by time (Today, Yesterday, Last 7 Days, Older)
- FR-9: Model selector dropdown — shows available models for active session's agent type
- FR-10: Welcome screen — displayed when a session has no messages yet
- FR-11: Stop streaming — user can abort a running response
- FR-12: Optional task linking — chat session can be linked to a Knowns task
- FR-13: Agent availability detection — check which CLIs are installed on PATH

### Non-Functional Requirements

- NFR-1: Session crash recovery — on server restart, mark all "streaming" sessions as "idle"
- NFR-2: One message at a time — reject send if session is already streaming
- NFR-3: Lightweight — no worktree, no orchestrator, no multi-phase pipeline
- NFR-4: Reuse existing ProcessManager — for process spawn, WebSocket streaming, event normalization
- NFR-5: Responsive UI — works on both desktop and mobile

## Architecture

### Data Model

```
ChatSession {
  id: string (base36)
  sessionId: string (UUID for --session-id)
  title: string
  agentType: "claude" | "opencode" (immutable after creation)
  model: string (switchable)
  status: "idle" | "streaming" | "error"
  taskId?: string (optional link to Knowns task)
  createdAt: string (ISO-8601)
  updatedAt: string (ISO-8601)
  messages: ChatMessage[]
}

ChatMessage {
  id: string
  role: "user" | "assistant"
  content: string
  model: string
  createdAt: string (ISO-8601)
  cost?: number (USD)
  duration?: number (ms)
}
```

### API Endpoints

```
GET    /api/chats           — list sessions (sorted by updatedAt desc)
POST   /api/chats           — create session { agentType, model, title?, taskId? }
GET    /api/chats/agents    — available agents + models
GET    /api/chats/{id}      — get session details
PATCH  /api/chats/{id}      — update (title, model) — reject agentType changes
DELETE /api/chats/{id}      — delete + stop if streaming
POST   /api/chats/{id}/send — send message → spawn process → stream via WS
POST   /api/chats/{id}/stop — kill running process
WS     /ws/chat?chatId=xxx  — WebSocket for live event streaming
```

### Send Message Flow

```
User → POST /api/chats/{id}/send { content }
  → Save user ChatMessage to session
  → Set status="streaming", SSE broadcast chats:updated
  → Spawn: claude -p "<msg>" --session-id <uuid> --output-format stream-json --verbose --model <model>
  → JSONL stdout → ProcessManager normalizes → WebSocket broadcasts ProxyEvents
  → UI renders events as live streaming response
  → Process exits → onComplete:
    → Parse text events → assistant content
    → Parse result event → cost, duration
    → Save assistant ChatMessage
    → Set status="idle", SSE broadcast chats:updated
```

### UI Layout

```
┌────────────────────┬──────────────────────────────────┐
│  Chat Sidebar      │  Chat Main Area                  │
│  ┌──────────────┐  │  ┌──────────────────────────┐    │
│  │ + New Chat   │  │  │ Model Selector Dropdown  │    │
│  │ Search...    │  │  └──────────────────────────┘    │
│  ├──────────────┤  │                                  │
│  │ Today        │  │  ┌──────────────────────────┐    │
│  │  Chat 1...   │  │  │                          │    │
│  │  Chat 2...   │  │  │  Welcome / Messages      │    │
│  │ Yesterday    │  │  │                          │    │
│  │  Chat 3...   │  │  └──────────────────────────┘    │
│  │ Last 7 Days  │  │                                  │
│  │  Chat 4...   │  │  ┌──────────────────────────┐    │
│  └──────────────┘  │  │ Chat Input + Send/Stop   │    │
│                    │  └──────────────────────────┘    │
└────────────────────┴──────────────────────────────────┘
```

## Acceptance Criteria

- [ ] AC-1: User can create a new chat session choosing Claude or OpenCode as agent type
- [ ] AC-2: User can have multiple sessions and switch between them via sidebar
- [ ] AC-3: Sessions are grouped by time in sidebar (Today, Yesterday, Last 7 Days, Older)
- [ ] AC-4: User can rename and delete chat sessions
- [ ] AC-5: Agent type is locked after session creation (cannot switch Claude ↔ OpenCode)
- [ ] AC-6: User can switch models within same agent type via dropdown
- [ ] AC-7: User can send a message and receive streaming response in real-time
- [ ] AC-8: Assistant responses render with markdown formatting
- [ ] AC-9: Tool use events display as collapsible blocks during streaming
- [ ] AC-10: User can stop a streaming response mid-generation
- [ ] AC-11: Message history persists across page refreshes
- [ ] AC-12: Welcome screen shows when session has no messages
- [ ] AC-13: Chat input supports Enter to send, Shift+Enter for newline
- [ ] AC-14: Server crash recovery marks streaming sessions as idle on restart
- [ ] AC-15: Only one message can be sent at a time (reject if already streaming)
- [ ] AC-16: Sidebar nav shows "AI Chat" instead of "AI Workspaces"
- [ ] AC-17: Old workspace UI components are removed from frontend

## Scenarios

### Scenario 1: Create and Chat
**Given** user is on the Chat page with no sessions
**When** user clicks "New Chat", selects "Claude" agent, picks "sonnet" model
**Then** a new session appears in sidebar, welcome screen shows, user can type and send messages

### Scenario 2: Switch Models Mid-Chat
**Given** user has an active Claude session with messages
**When** user changes model from "sonnet" to "opus" via dropdown
**Then** next message uses opus model, previous messages unaffected

### Scenario 3: Agent Type Lock
**Given** user has a Claude session
**When** user tries to switch agent type to OpenCode
**Then** system prevents the change (dropdown only shows models for current agent)

### Scenario 4: Stop Streaming
**Given** assistant is streaming a long response
**When** user clicks Stop button
**Then** streaming stops, partial response is saved, session returns to idle

### Scenario 5: Session Persistence
**Given** user has multiple sessions with messages
**When** user refreshes the page
**Then** all sessions and their message history are preserved

### Scenario 6: Server Crash Recovery
**Given** server crashes while a session is streaming
**When** server restarts
**Then** session status is reset to "idle" (not stuck in "streaming")

## Technical Notes

### Backend Changes
- Reuse process/session orchestration from the existing server layer; this spec originally named the old `internal/server/workspace/process.go` path, but current repo paths differ after the rewrite.
- New files: @code/internal/models/chat.go, @code/internal/storage/chat_store.go, @code/internal/server/routes/chat.go
- Storage: `.knowns/chats.json` (single file, same pattern as `workspaces.json`)
- SSE events: `chats:created`, `chats:updated`, `chats:deleted`, `chats:message`

### Frontend Changes
- New files: @code/ui/src/models/chat.ts, @code/ui/src/contexts/ChatContext.tsx, @code/ui/src/pages/ChatPage.tsx
- Modify: terminal websocket hook, @code/ui/src/App.tsx, @code/ui/src/components/organisms/AppSidebar.tsx, @code/ui/src/api/client.ts
- Remove: legacy workspace page/context surfaces from the pre-rewrite layout

### OpenCode Session Continuity
Claude supports `--session-id` natively. OpenCode may not — if unsupported, prepend previous messages in prompt as fallback.

## Open Questions

- [ ] Should chat sessions be visible in the MCP tools? (e.g. `list_chats`, `send_chat_message`)
- [ ] Should there be a maximum number of stored messages per session?
- [ ] Should old sessions auto-archive after N days of inactivity?


> **Superseded** by @decision/20260819-1703-remove-the-opencode-chat-ui - the OpenCode Chat UI was removed from Knowns.
