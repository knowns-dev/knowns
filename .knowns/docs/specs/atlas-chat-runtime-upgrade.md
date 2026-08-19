---
id: doc-4dd541b78b53b77d5d3d5f92af776762
title: Atlas Chat Runtime Upgrade
description: Spec for upgrading chat rendering, timeline flow, and hybrid OpenCode runtime management using the Atlas pattern.
createdAt: '2026-04-09T09:52:54.570Z'
updatedAt: '2026-08-19T10:04:29.309Z'
tags:
  - spec
  - chat
  - opencode
  - ui
  - runtime
  - superseded
---

# Atlas Chat Runtime Upgrade

## Overview

Specification for upgrading Knowns chat experience and OpenCode runtime handling using the Atlas pattern defined in @doc/patterns/pattern-atlas-chat-runtime.

This spec combines two goals:
- improve chat transcript rendering and navigation for tool-heavy AI conversations
- make OpenCode runtime mode, readiness, and recovery more explicit and observable

Related docs:
- @doc/patterns/pattern-atlas-chat-runtime
- @doc/specs/chat-ui
- @doc/specs/chat-ui-revert-copy
- @doc/specs/session-info-panel
- @doc/specs/knowns-hub-mode
- @doc/specs/auto-download-opencode

## Requirements

### Functional Requirements

- FR-1: Chat messages must render as structured blocks instead of one monolithic presentation path.
- FR-2: Tool-heavy assistant messages must support specialized renderers for high-value tool outputs.
- FR-3: Users must be able to access consistent message actions including copy, revert, and fork from message history.
- FR-4: Chat history must support a timeline-style navigation surface for searching, jumping, reverting, and forking.
- FR-5: The chat layout must support a real right sidebar for runtime/session context.
- FR-6: The composer must support stronger mobile and long-session ergonomics.
- FR-7: Knowns must expose explicit OpenCode runtime mode: managed, external, unavailable, or degraded.
- FR-8: Knowns must use staged readiness checks so OpenCode is not considered ready on shallow health alone.
- FR-9: Knowns must support external OpenCode configuration without forcing managed daemon startup.
- FR-10: Knowns must monitor runtime health and attempt safe recovery for managed mode.
- FR-11: Chat UI must surface runtime status so users can understand readiness and failures.

### Non-Functional Requirements

- NFR-1: Keep the existing `ChatMessage[]` storage model.
- NFR-2: Preserve shared daemon behavior for managed mode.
- NFR-3: Avoid a full frontend rewrite or new store architecture.
- NFR-4: Keep rollout incremental so each phase can ship independently.
- NFR-5: Do not kill external OpenCode processes owned outside Knowns.

## Acceptance Criteria

- AC-1: `MessageBubble` rendering is split into focused render blocks for text, reasoning, tools, questions, attachments, errors, and actions.
- AC-2: A renderer registry exists for tool calls with specialized rendering for at least `read`, `grep`, `glob`, `bash`, and patch/diff-like outputs.
- AC-3: Generic fallback rendering remains available for unsupported tool names.
- AC-4: Users can access copy, revert, and fork actions from message history through a consistent toolbar.
- AC-5: A timeline/history surface supports search, jump-to-message, revert-from-here, and fork-from-here.
- AC-6: `ChatRightSidebar` is integrated into the main chat page and shows runtime/session context.
- AC-7: Composer UX supports mobile-friendly controls and better long-session behavior without changing storage format.
- AC-8: Server runtime reports explicit OpenCode mode and state, including managed vs external.
- AC-9: Server readiness checks include `/global/health`, `/config`, and `/agent` before reporting ready.
- AC-10: Knowns can use external OpenCode configuration without spawning the managed daemon.
- AC-11: Managed mode performs health monitoring and controlled recovery without breaking existing daemon reuse.
- AC-12: Chat UI exposes runtime status, version, and last error in an observable surface.

## Scenarios

### Scenario 1: Tool-heavy assistant turn
A user asks for codebase research. The assistant responds with text plus multiple tool results. The chat transcript renders readable blocks instead of large raw output blobs.

### Scenario 2: Revert and branch from history
A user opens timeline history, searches for a previous message, and chooses either revert or fork from that point.

### Scenario 3: External OpenCode server configured
A user configures Knowns to attach to an already-running OpenCode server. Knowns skips daemon spawn, probes readiness, and shows runtime mode as external.

### Scenario 4: Managed daemon becomes unhealthy
Knowns detects failed readiness checks for a managed daemon, marks runtime degraded, attempts controlled recovery, and surfaces status to the UI.

### Scenario 5: Mobile chat session
A user on mobile can still access model/agent controls and send messages without overloading the composer area.

## Technical Notes

### Implementation Phases

1. Message block rendering and tool renderer registry
2. Timeline/history actions and right sidebar integration
3. Composer UX improvements
4. OpenCode runtime mode, readiness, health monitoring, and status surfacing

### Existing code entry points

Frontend:
- `ui/src/pages/ChatPage.tsx`
- `ui/src/components/chat/ChatThread.tsx`
- `ui/src/components/chat/MessageBubble.tsx`
- `ui/src/components/organisms/ChatPage/ChatInput.tsx`
- `ui/src/components/organisms/ChatPage/ChatRightSidebar.tsx`

Backend:
- `internal/server/server.go`
- `internal/agents/opencode/daemon.go`
- `internal/agents/opencode/client.go`
- `internal/agents/opencode/detect.go`

## Open Questions

- Should runtime status be shown primarily in the toolbar, sidebar, or both?
- Should timeline UI launch as a dialog, right panel, or route-level subview?
- Which additional tool renderers beyond the initial set are worth prioritizing after the first pass?


> **Superseded** by @decision/20260819-1703-remove-the-opencode-chat-ui - the OpenCode Chat UI was removed from Knowns.
