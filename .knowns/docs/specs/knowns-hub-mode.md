---
id: doc-2a5208c0970e7f059b8fc7a41c9d2f37
title: Knowns Hub Mode
description: 'Specification for Hub Mode: standalone app with shared OpenCode daemon, project registry, workspace switching, and port handling fixes'
createdAt: '2026-03-24T07:08:41.276Z'
updatedAt: '2026-08-19T10:04:38.317Z'
tags:
  - spec
  - approved
---

# Knowns Hub Mode

## Overview

Hub Mode transforms Knowns from a per-project CLI tool into a standalone application. Users can launch Knowns without being inside a repository, browse and switch between multiple workspaces, and share a single OpenCode daemon across all projects instead of spawning a new process each time.

## Requirements

### Functional Requirements

- FR-1: Fix port file race condition — the `.server-port` file must only be written after the TCP port is successfully bound.
- FR-2: Propagate server bind errors — if `ListenAndServe` (or `Serve`) fails, the error must be returned to the caller instead of being silently swallowed in a goroutine.
- FR-3: Cleanup `.server-port` on shutdown — when the server receives SIGINT/SIGTERM, the port file must be removed before the process exits.
- FR-4: Implement a proper `stopExistingServer()` — the restart flow must send a shutdown signal to the running server and wait for the port to be released, rather than only checking if the port responds.
- FR-5: Shared OpenCode daemon — a single OpenCode server process runs as a daemon (detached, with PID file at `~/.knowns/opencode.pid`). All Knowns instances reuse it instead of spawning their own.
- FR-6: Daemon lifecycle management — `EnsureRunning()` checks PID file + process liveness + HTTP health. If the daemon is dead or unresponsive, it is restarted automatically.
- FR-7: Project registry — a global registry at `~/.knowns/registry.json` stores known project paths, names, and last-used timestamps.
- FR-8: Filesystem scan — `knowns browser --scan <dirs>` (and `POST /api/workspaces/scan`) discovers directories containing `.knowns/` folders and adds them to the registry.
- FR-9: Workspace switch API — `POST /api/workspaces/switch` swaps the active project at runtime without restarting the server. The server reloads the store and notifies connected clients via SSE.
- FR-10: Standalone launch — `knowns browser` without being inside a repo loads the registry and opens the last-active project, or shows a workspace picker if no project is registered.
- FR-11: Workspace picker UI — a React component that lists registered projects, allows selecting one, and supports adding new projects via folder picker or manual path input.

### Non-Functional Requirements

- NFR-1: Backward compatibility — all existing single-project workflows (`knowns browser` inside a repo) must continue to work unchanged.
- NFR-2: Resource efficiency — only one OpenCode process and one Knowns HTTP server should run at any time, regardless of how many projects are registered.
- NFR-3: Graceful degradation — if the OpenCode CLI is not installed, Hub Mode still works for task/doc management; only AI chat features are unavailable.
- NFR-4: Startup latency — switching workspaces should complete in under 500ms (excluding network-dependent operations).

## Acceptance Criteria

- [ ] AC-1: `.server-port` is written only after `net.Listen` succeeds; if binding fails, no port file exists.
- [ ] AC-2: A bind failure on the configured port returns an error from `Start()` instead of hanging silently.
- [ ] AC-3: After SIGINT/SIGTERM, the `.server-port` file is removed and the port is released.
- [ ] AC-4: `knowns browser --restart` sends a shutdown request to the existing server and waits for the port to be freed before starting a new one.
- [ ] AC-5: Running `knowns browser` twice does not spawn two OpenCode processes; the second invocation reuses the daemon started by the first.
- [ ] AC-6: If the OpenCode daemon crashes, the next `knowns browser` or health-check cycle restarts it automatically.
- [ ] AC-7: `GET /api/workspaces` returns the list of registered projects with name, path, and last-used timestamp.
- [ ] AC-8: `POST /api/workspaces/scan` with a list of directories returns newly discovered projects and persists them to the registry.
- [ ] AC-9: `POST /api/workspaces/switch` with a project ID reloads the store; subsequent API calls (tasks, docs) reflect the new project's data.
- [ ] AC-10: SSE clients receive a `refresh` event after a workspace switch so the UI reloads all data.
- [ ] AC-11: `knowns browser` launched outside any repo opens the workspace picker UI if no project is registered, or loads the last-active project otherwise.
- [ ] AC-12: The workspace picker UI lists all registered projects and allows the user to select, add, or remove projects.

## Scenarios

### Scenario 1: Normal startup inside a repo (backward compat)
**Given** the user is inside a directory with `.knowns/`
**When** they run `knowns browser`
**Then** the server starts on the configured port, the port file is written after binding, and the browser opens — identical to current behavior.

### Scenario 2: Port already in use
**Given** another process occupies port 3001
**When** the user runs `knowns browser --port 3001`
**Then** `Start()` returns an error like "failed to listen on :3001: address already in use" and no port file is written.

### Scenario 3: Restart with existing server
**Given** a Knowns server is running on port 3001
**When** the user runs `knowns browser --restart --port 3001`
**Then** the old server receives a shutdown request, the port is freed, and a new server starts on port 3001.

### Scenario 4: Shared OpenCode daemon
**Given** no OpenCode daemon is running
**When** the user runs `knowns browser` for project A, then opens a second terminal and runs `knowns browser --port 3002` for project B
**Then** only one `opencode serve` process exists (verified by PID file), and both Knowns servers proxy to it.

### Scenario 5: Daemon crash recovery
**Given** the OpenCode daemon is running (PID file exists)
**When** the daemon process is killed externally
**Then** the next health check (or next `knowns browser` launch) detects the dead process and restarts the daemon.

### Scenario 6: Standalone launch without repo
**Given** the user is in `~/Desktop` (no `.knowns/` folder) and the registry contains two projects
**When** they run `knowns browser`
**Then** the server starts and loads the most recently used project from the registry.

### Scenario 7: First launch with empty registry
**Given** the user has never used Knowns before (no `~/.knowns/registry.json`)
**When** they run `knowns browser`
**Then** the workspace picker UI is shown, prompting the user to add a project folder.

### Scenario 8: Workspace switch at runtime
**Given** the server is running with project A active, and the UI is open
**When** the user selects project B in the workspace picker
**Then** `POST /api/workspaces/switch` is called, the store reloads, an SSE `refresh` event fires, and the UI shows project B's tasks and docs.

### Scenario 9: Scan for projects
**Given** the user has multiple repos under `~/projects/`
**When** they click "Scan" in the workspace picker and provide `~/projects/`
**Then** all subdirectories containing `.knowns/` are added to the registry and appear in the picker.

## Technical Notes

### Architecture

```
┌─────────────────────────────────────────────────┐
│                  Browser UI                      │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐ │
│  │ Workspace │  │  Board   │  │   OpenCode    │ │
│  │  Picker   │  │  /Tasks  │  │   Chat UI     │ │
│  └─────┬─────┘  └────┬─────┘  └──────┬────────┘ │
└────────┼──────────────┼───────────────┼──────────┘
         │              │               │
    ┌────▼──────────────▼───────────────▼────┐
    │          Knowns HTTP Server             │
    │  ┌─────────────┐  ┌────────────────┐   │
    │  │   Project    │  │   OpenCode     │   │
    │  │  Registry    │  │   Proxy        │   │
    │  │  + Switcher  │  │  (shared)      │   │
    │  └──────┬───────┘  └───────┬────────┘   │
    │         │                  │             │
    │  ┌──────▼───────┐  ┌──────▼────────┐   │
    │  │  Multi-Store  │  │  OpenCode     │   │
    │  │  Manager      │  │  Daemon       │   │
    │  └───────────────┘  └───────────────┘   │
    └─────────────────────────────────────────┘
```

### New packages
- @code/internal/registry — project registry (CRUD, scan, persist)
- @code/internal/agents/opencode/daemon.go — daemon lifecycle (PID file, health check, start/stop)
- @code/internal/storage/manager.go — multi-store manager (lazy load, switch, cleanup)
- @code/internal/server/routes/workspace.go — workspace API endpoints

### Key implementation details
- Port fix: use `net.Listen` first, then `srv.Serve(listener)` instead of `srv.ListenAndServe`
- Daemon PID file: `~/.knowns/opencode.pid`
- Registry file: `~/.knowns/registry.json`
- Daemon detach: `cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}`
- Store switch: lazy-load into `map[string]*Store`, cleanup idle stores after timeout

### Implementation Phases
| Phase | Scope | Risk |
|-------|-------|------|
| 1. Fix Port Bugs | @code/internal/server/server.go, @code/internal/cli/browser.go | Low — isolated fixes |
| 2. OpenCode Daemon | @code/internal/agents/opencode/daemon.go | Medium — process management |
| 3. Project Registry | @code/internal/registry, workspace API routes | Low — new code, no breaking changes |
| 4. UI Workspace Switcher | React components, API integration | Medium — UX design needed |
## Open Questions

- [ ] Should the daemon port be configurable globally (`~/.knowns/config.json`) or always derived from a fixed default?
- [ ] Should workspace switch trigger a full page reload or a soft data refresh via SSE?
- [ ] Should the registry support "pinned" or "favorite" projects for quick access?
- [ ] How should MCP handlers (separate process) discover the active project after a workspace switch?


> **Partially void** by @decision/20260819-1703-remove-the-opencode-chat-ui. The standalone app, project registry, workspace switching and port handling remain valid. The shared-OpenCode-daemon requirements are void: FR-5, NFR-2, NFR-3, AC-5, AC-6 and Scenario 4.
