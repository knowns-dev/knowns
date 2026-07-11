---
title: Project LSP Daemon for Shared MCP Code Runtime
description: 'Specification for a project-scoped daemon that owns LSP/code intelligence runtime across multiple MCP sessions, preventing per-session LSP process fan-out and unintended C# startup.'
createdAt: '2026-07-07T17:06:25.909Z'
updatedAt: '2026-07-07T17:11:33.893Z'
tags:
  - spec
  - approved
  - lsp
  - runtime
  - mcp
  - daemon
  - code-intelligence
---

## Overview

Introduce a project-scoped Knowns daemon that owns LSP-backed code intelligence and LSP runtime administration for a canonical project root. Existing `knowns mcp --stdio` processes remain the public MCP entrypoint, but for `code.*` tools and LSP runtime/status/admin surfaces they become thin clients that connect to the project daemon instead of each spawning their own in-process LSP manager and language-server children.

The goal is to prevent OOM and process fan-out when several AI sessions are attached to the same project, while preserving existing CLI/MCP/API behavior. This is inspired by Serena's shared-instance model for multiple agents on one project, but Knowns should auto-manage the daemon so users do not need to manually switch to HTTP mode.

Related context:
- @doc/specs/global-runtime-queue-for-mcp-and-background-work
- @doc/specs/lsp-runtime-wrapper-and-managed-backends
- @doc/specs/runtime-process-dashboard

## Locked Decisions

- D1: Build a full project daemon: MCP processes act as thin clients for code intelligence, while daemon owns runtime/code intelligence/LSP lifecycle for the project.
- D2: C# LSP starts only when a `code.*` request directly targets a C# file, or when the user explicitly starts/enables C#; project scans alone must not auto-start C#.
- D3: Use hybrid lifecycle: WebUI/runtime-held daemons may remain long-lived, while MCP-stdio-spawned daemons stop after an idle timeout.
- D4: Phase one scope is `code.*` plus runtime status/admin LSP surfaces. Docs, tasks, memory, and unrelated MCP tools remain local to the MCP process.
- D5: On daemon or IPC failure, MCP clients retry reconnect/restart once under the project lock; if recovery fails, return a clear error with log/status guidance and do not fallback to local LSP spawning.
- D6: Use hybrid transport: Unix domain socket or Windows named pipe for MCP stdio thin clients; HTTP remains available for WebUI/admin/runtime surfaces when an HTTP server is already present.
- D7: Phase one is compatibility-first: keep public CLI/MCP/API command shape and response contracts stable, adding new fields only where safe.
- D8: Status/admin LSP surfaces expose daemon ownership clearly and additively: daemon state, PID, clients, transport, idle deadline, LSP owner, and per-server running state.
- D9: Access control uses same-user filesystem protection plus project identity/token handshake. Clients for the wrong canonical project root must be rejected.
- D10: Provide a temporary env kill switch for dev/support rollback, defaulting daemon mode on. When disabled, status must explicitly report daemon disabled by env and warn about per-MCP local LSP fan-out.

## Requirements

### Functional Requirements

- FR-1: `knowns mcp --stdio` must no longer eagerly start detected LSP servers during MCP session registration when daemon mode is enabled.
- FR-2: For a canonical project root, at most one daemon should own active LSP server processes for phase-one code intelligence at a time.
- FR-3: Multiple MCP stdio processes connected to the same project must route `code.*` requests through the same project daemon.
- FR-4: The daemon must own the `lsp.Manager` or equivalent runtime/session surface used by `code.*` handlers.
- FR-5: Existing `code.*` MCP tool names, request schemas, and successful response shapes must remain compatible unless an additive field is explicitly documented.
- FR-6: LSP runtime status used by CLI, MCP `initial`, WebUI, API, and admin commands must report daemon ownership and must distinguish `installed` from `running`.
- FR-7: C# status may report installed backend availability, but must not imply a running C# process unless the daemon has actually started C#.
- FR-8: C# LSP must not auto-start only because C# files or project markers are discovered during project scan; it may start only for direct C# `code.*` file access or explicit user/admin action.
- FR-9: The daemon must canonicalize project root identity before lock acquisition and client handshake to avoid duplicate daemons for symlink-equivalent paths.
- FR-10: MCP clients must locate, connect to, or spawn the daemon using project-scoped lock/state files with user-only permissions.
- FR-11: If daemon connection fails, the client must attempt one bounded reconnect/restart sequence before returning failure.
- FR-12: If the bounded recovery fails, the client must not spawn local LSP servers as fallback; the error must include the daemon state/log path when available.
- FR-13: MCP-spawned daemons must track active clients and recent requests and stop after an idle timeout when no WebUI/runtime owner is holding them.
- FR-14: WebUI/runtime-held daemons may stay running beyond the MCP idle timeout while they have an explicit owner/lease.
- FR-15: Daemon status must expose daemon state, daemon PID, client count, transport, ownership mode, idle deadline, and per-language LSP state.
- FR-16: LSP admin operations such as start, stop, restart, enable/disable, and config apply must route to the daemon for phase-one languages when daemon mode is enabled.
- FR-17: A temporary environment kill switch must disable daemon routing for dev/support, with explicit status/log warnings that local LSP fallback may spawn per MCP process.
- FR-18: Runtime logs must make process ownership clear enough to identify whether an LSP child was launched by the daemon or by a local fallback path.

### Non-Functional Requirements

- NFR-1: The default path must reduce duplicate LSP processes for same-project multi-session use and avoid reintroducing per-session LSP fan-out during normal failures.
- NFR-2: First `code.*` request latency may include daemon startup, but reconnect and status checks must use bounded timeouts and never hang indefinitely.
- NFR-3: The design must work on macOS, Linux, and Windows, including named pipe support and Windows-safe lock/token storage.
- NFR-4: Security must be local-first: no remote daemon access in phase one, and same-user/project-token checks must protect socket/pipe access.
- NFR-5: Implementation should reuse the existing LSP session abstraction and runtime status snapshot where practical instead of creating a second status model.
- NFR-6: Existing docs/tasks/memory MCP behavior must remain unaffected by daemon failures in phase one.

## Acceptance Criteria

- [ ] AC-1: Starting two `knowns mcp --stdio` processes for the same project and invoking Go `code.*` from both results in one shared `gopls` process owned by the project daemon, not one `gopls` per MCP process.
- [ ] AC-2: MCP session registration by itself does not start `gopls`, TypeScript LS, SCSS LS, or C# LS before a code-intelligence or explicit admin request needs them.
- [ ] AC-3: A Go/TypeScript-only project with `csharp-ls` installed reports C# as installed but not running, and no `csharp-ls` child process is launched by session startup or project status.
- [ ] AC-4: Direct `code.*` access to a `.cs` file starts C# in the daemon when C# is enabled and resolvable.
- [ ] AC-5: Explicit user/admin start of C# starts C# in the daemon and status reports `owner=daemon` plus the server PID.
- [ ] AC-6: CLI/MCP/WebUI status distinguish daemon state from LSP install state and distinguish LSP `installed` from `running`.
- [ ] AC-7: If the daemon dies while an MCP client is active, the next `code.*` request attempts one reconnect/restart and succeeds when restart is possible.
- [ ] AC-8: If daemon restart fails, `code.*` returns a clear daemon error and does not start a local language server in the MCP process.
- [ ] AC-9: With daemon mode enabled, LSP admin restart/stop/start commands affect the daemon-owned language server and are visible to all connected MCP clients.
- [ ] AC-10: MCP-spawned daemon exits after the configured idle timeout when no clients/requests or WebUI/runtime lease remain.
- [ ] AC-11: WebUI/runtime-held daemon remains alive past MCP idle timeout while its explicit lease is active.
- [ ] AC-12: Clients using a symlinked project path and the canonical project path resolve to the same daemon instead of creating duplicate daemons.
- [ ] AC-13: A client presenting the wrong project identity/token is rejected and cannot issue `code.*` or LSP admin requests to another project's daemon.
- [ ] AC-14: Setting the rollback environment variable disables daemon routing, status reports `daemon=disabled_by_env`, and logs warn about per-MCP LSP fan-out risk.
- [ ] AC-15: Existing non-code MCP tools for docs/tasks/memory continue to work even if the code daemon is stopped or unhealthy.

## Scenarios

### Scenario 1: Multi-session Go code intelligence
**Given** two AI sessions start `knowns mcp --stdio` in the same Go project
**When** both sessions request symbols, definitions, or references for Go files
**Then** both requests route through the same project daemon
**And** only one `gopls` process is owned by that daemon for the project.

### Scenario 2: Startup without code use
**Given** an AI client starts an MCP session for a Go/TypeScript project
**When** the client only reads docs, tasks, memory, or project status
**Then** the MCP process does not start LSP child processes
**And** status can show installed language backends without reporting them as running.

### Scenario 3: Installed C# in a non-C# project
**Given** `csharp-ls` is installed on PATH
**And** the active project has Go and TypeScript code but no direct C# code request
**When** the user starts multiple MCP sessions and checks status
**Then** C# may appear as installed
**But** no C# language-server process is launched
**And** status does not label C# as running.

### Scenario 4: Direct C# file access
**Given** the project contains a C# file or the user explicitly targets a C# file path
**When** a `code.*` request needs semantic information for that `.cs` file
**Then** the daemon resolves and starts the configured C# backend if enabled
**And** subsequent C# requests from other MCP clients reuse that daemon-owned process.

### Scenario 5: Daemon recovery
**Given** the project daemon was running and then crashed
**When** the next `code.*` request arrives from an MCP client
**Then** the client attempts one bounded reconnect/restart
**And** either routes the request to the recovered daemon or returns a clear daemon failure without local LSP fallback.

### Scenario 6: Idle lifecycle
**Given** the daemon was auto-spawned by MCP stdio
**And** all clients disconnect or become idle with no WebUI/runtime lease
**When** the idle timeout expires
**Then** the daemon stops its LSP servers and exits cleanly.

### Scenario 7: WebUI lease
**Given** the WebUI/runtime server has an active lease on the project daemon
**When** MCP stdio clients disconnect
**Then** the daemon remains alive past the MCP idle timeout
**And** status explains the owner/lease keeping it alive.

### Scenario 8: Rollback mode
**Given** support sets the daemon kill switch environment variable
**When** MCP starts and a `code.*` request is made
**Then** daemon routing is disabled
**And** status/logs clearly mark the fallback mode and duplicate-LSP risk.

## Technical Notes

- Current OOM risk comes from per-process MCP lifecycle starting detected LSPs: `internal/mcp/lifecycle_hooks.go` calls `lsp.Manager.ClientConnected`, and `internal/lsp/manager.go` currently starts detected language servers for the first client in that process.
- Existing lazy code paths through `Manager.WithSession` and `ServerForPath` should remain the caller-facing boundary, but the owning manager should live in the daemon for phase-one code paths.
- Existing runtimequeue/shared runtime code may be reused or extended if it fits project-scoped ownership, locking, logs, leases, and status; the planning phase should decide whether this is an extension of `knowns __runtime run` or a dedicated project LSP daemon process.
- Status should build on `lsp.LanguageRuntimeStatus` / `CollectRuntimeStatuses` so CLI, MCP `initial`, server routes, and WebUI do not diverge.
- The rollback environment variable name should be finalized during planning; proposed placeholder: `KNOWNS_LSP_DAEMON=0`.
- Transport details should be implemented behind an internal client interface so handlers do not depend on socket/pipe specifics.

## Task Links

- @task-qx96bu [lsp-daemon-01] Add project daemon identity, lock, and IPC foundation — todo
- @task-dgm13t [lsp-daemon-02] Route MCP code tools through the project daemon — todo
- @task-e5fjsr [lsp-daemon-03] Move LSP session ownership and C# startup policy into daemon — todo
- @task-axfz53 [lsp-daemon-04] Route LSP status and admin operations through daemon — todo
- @task-dokp6l [lsp-daemon-05] Add daemon recovery, lifecycle leases, idle timeout, and kill switch — todo

## Open Questions

- [ ] What exact default idle timeout should be used for MCP-spawned daemons?
- [ ] Should the phase-one daemon be implemented as an extension of the existing shared runtime queue process or as a dedicated project LSP daemon?
- [ ] What exact rollback environment variable name should be standardized?
