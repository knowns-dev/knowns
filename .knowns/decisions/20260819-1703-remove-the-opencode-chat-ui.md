---
id: 20260819-1703-remove-the-opencode-chat-ui
title: Remove the OpenCode Chat UI
status: accepted
supersedes: []
supersededBy: []
tags:
  - chat
  - opencode
  - ui
  - removal
sources:
  - commit 37db056
relatedDocs:
  - specs/chat-ui
  - specs/chat-ui-revert-copy
  - specs/session-info-panel
  - specs/atlas-chat-runtime-upgrade
  - specs/continue-streaming-message
  - patterns/pattern-atlas-chat-runtime
  - specs/auto-download-opencode
  - specs/knowns-hub-mode
relatedTasks:
  - i5fheq
verification:
  - 'source:commit 37db056'
  - 'task:@task-i5fheq:done'
verifiedAt: '2026-08-19T10:04:12.260Z'
createdAt: '2026-08-19T10:03:24.349Z'
updatedAt: '2026-08-19T10:04:12.260Z'
---

## Context

The Chat UI shipped under @doc/specs/chat-ui as an embedded OpenCode web chat inside `knowns browser`, gated by the `enableChatUI` setting. It grew its own runtime: a spawned OpenCode daemon with a PID file, an HTTP reverse proxy, a `/ws/chat` WebSocket bridge, an SSE forwarder re-broadcasting OpenCode events, a 15s health monitor, and roughly 40 frontend files with their own provider tree mounted unconditionally in the React app.

Nothing else in Knowns depended on it. A survey found the feature also carried dead weight: `/api/chats` and `models.ChatSession` were mounted ungated with most streaming endpoints already stubbed to 503 and no consumer, and a chain of orphaned frontend components had no importers at all.

Separately, @doc/specs/auto-download-opencode was approved but never implemented. Knowns never downloaded the `opencode` binary. What existed instead was an exception in `validateInstallable` plus a `CanAutoInstall` bypass that let `knowns setup opencode` write runtime hooks even when the CLI was absent from PATH, producing hooks pointing at a binary that was not there.

## Decision

Remove the Chat UI in full: the frontend, the `internal/agents/opencode` runtime package, the server proxy/WebSocket/monitor/SSE wiring, the `enableChatUI`, `opencodeServer` and `opencodeModels` settings, and the ungated `/api/chats` surface.

Users install and run `opencode` themselves. The PATH exception is removed so OpenCode is validated like every other runtime before Knowns writes hooks for it.

`knowns browser` is NOT removed. It keeps serving the whole web app: dashboard, kanban, tasks, docs, imports, graph, memory, decisions, audit and config.

OpenCode as an AI agent platform is NOT affected: `OPENCODE.md`, `opencode.json`, MCP config generation, skill sync and the `settings.platforms` enum all stay.

## Alternatives Considered

Keep it behind the `enableChatUI` flag. Rejected: the flag never gated the whole cost. The SSE forwarder and runtime monitor started unconditionally, `/api/chats` was mounted ungated, and the React provider tree mounted regardless of the setting.

Extract it into a plugin. Rejected: Knowns has no plugin surface for web UI features, so this would mean building one first for a feature being retired.

## Consequences

Superseded in full: @doc/specs/chat-ui, @doc/specs/chat-ui-revert-copy, @doc/specs/session-info-panel, @doc/specs/atlas-chat-runtime-upgrade, @doc/specs/continue-streaming-message, @doc/patterns/pattern-atlas-chat-runtime, @doc/specs/auto-download-opencode.

Partially void, NOT superseded: @doc/specs/knowns-hub-mode. Its standalone app, project registry, workspace switching and port handling remain valid. Its shared-OpenCode-daemon requirements are void: FR-5, NFR-2, NFR-3, AC-5, AC-6 and Scenario 4.

Breaking for users: `enableChatUI`, `opencodeServer` and `opencodeModels` are no longer read from project config; leftover keys are ignored. The `Browser / Chat UI` entry is gone from the `knowns settings` menu. `knowns setup opencode` now fails with "OpenCode CLI is not available in PATH" instead of silently writing hooks for a missing binary.

The `runtime.managed-services` doctor check remains but can only report skip, since Knowns no longer manages a runtime service of its own.
