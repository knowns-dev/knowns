---
title: Runtime Process Dashboard
description: 'Specification for extending `knowns runtime ps` to display all managed sub-processes: OpenCode daemon, LSP servers, Cloudflared tunnel, and Embedding sidecar'
createdAt: '2026-05-27T07:41:28.849Z'
updatedAt: '2026-05-27T07:44:46.143Z'
tags:
  - spec
  - approved
  - runtime
  - cli
  - webui
  - api
---

## Overview

Extend `knowns runtime ps` to show a complete view of all managed sub-processes in the Knowns ecosystem. Currently it displays runtime status, MCP clients, and jobs. This spec adds visibility into OpenCode daemon, LSP servers, Cloudflared tunnel, and Embedding sidecar — giving users a single `docker ps`-like view of everything Knowns manages.

## Locked Decisions

- D1: Extend existing `knowns runtime ps` command (no new command)
- D2: Show 4 sub-process types: OpenCode daemon, LSP servers, Cloudflared tunnel, Embedding sidecar
- D3: Detail level: Name, PID, status, port, uptime, memory usage
- D4: Show all processes including stopped ones (dimmed with \"stopped\" status)

## Requirements

### Functional Requirements

- FR-1: `runtime ps` displays a \"Services\" section showing all managed sub-processes
- FR-2: Each process entry shows: name, PID (if running), status, port (if applicable), uptime
- FR-3: OpenCode daemon shows: mode (managed/external), host:port, version
- FR-4: LSP servers show: per-language entries with binary path, language name
- FR-5: Cloudflared tunnel shows: tunnel URL, PID
- FR-6: Embedding sidecar shows: model name, provider (local/api/ollama)
- FR-7: Stopped/disabled processes appear dimmed with reason (disabled, not installed, crashed)
- FR-8: `--json` flag outputs structured JSON for all process info
- FR-9: `--plain` flag outputs machine-readable plain text

### Non-Functional Requirements

- NFR-1: Process detection must complete within 2 seconds (no hanging on dead processes)
- NFR-2: PID checks must handle stale PID files gracefully (process died without cleanup)
- NFR-3: Memory usage display is optional — only show if available without elevated permissions

## Acceptance Criteria

- [ ] AC-1: `knowns runtime ps` shows OpenCode daemon status (running/stopped, pid, port)
- [ ] AC-2: `knowns runtime ps` shows LSP server status per configured language
- [ ] AC-3: `knowns runtime ps` shows Cloudflared tunnel status (running/stopped, URL)
- [ ] AC-4: `knowns runtime ps` shows Embedding sidecar/provider status
- [ ] AC-5: Stopped processes appear with dimmed styling and \"stopped\" label
- [ ] AC-6: `--json` outputs all process info as structured JSON
- [ ] AC-7: Command completes within 2 seconds even when processes are unreachable
- [ ] AC-8: Stale PID files do not cause false \"running\" status

## Scenarios

### Scenario 1: All services running
**Given** OpenCode daemon, LSP (Go, TypeScript), Cloudflared, and Embedding API are all active
**When** user runs `knowns runtime ps`
**Then** output shows Services section with all entries as green/running with PIDs and ports

### Scenario 2: Mixed state
**Given** OpenCode is disabled (enableChatUI=false), LSP Go is running, Cloudflared is stopped
**When** user runs `knowns runtime ps`
**Then** OpenCode shows dimmed \"stopped (disabled)\", LSP Go shows running, Cloudflared shows dimmed \"stopped\"

### Scenario 3: Process crashed (stale PID)
**Given** LSP server crashed but PID file still exists
**When** user runs `knowns runtime ps`
**Then** LSP shows \"stopped\" (not \"running\"), stale PID file is cleaned up

### Scenario 4: JSON output
**Given** user runs `knowns runtime ps --json`
**Then** output is valid JSON with `services` array containing all process entries with status, pid, port, uptime fields

## Technical Notes

- OpenCode daemon status: check via `opencode.Daemon` PID file + health endpoint
- LSP servers: check via `internal/lsp` manager — each language has its own process
- Cloudflared: check via PID file in `~/.knowns/runtime/` or process detection
- Embedding sidecar: check via `knowns-embed` process or API provider connectivity
- Use `os.FindProcess` + signal 0 for PID liveness check
- Timeout all health checks to prevent hanging

## Output Layout

```
Runtime  ● running  pid=59324  vdev

┌─ Services (4) ──────────────────────────────────────────────┐
│ ● OpenCode      managed  pid=12345  :4096  uptime=2h30m    │
│ ● LSP (go)      running  pid=12346  :0     uptime=1h15m    │
│ ● LSP (ts)      running  pid=12347  :0     uptime=1h15m    │
│ ○ Cloudflared   stopped                                    │
│ ● Embedding     api      model=nemotron-embed  2048d       │
└─────────────────────────────────────────────────────────────┘

┌─ Clients (3) ───────────────────────────────────────────────┐
│ ...
└─────────────────────────────────────────────────────────────┘

┌─ Jobs ──────────────────────────────────────────────────────┐
│ ...
└─────────────────────────────────────────────────────────────┘
```

## Open Questions

- [ ] Should `runtime ps` also show WebUI server itself (pid, port)?
- [ ] Should memory usage require `--verbose` flag to avoid slow syscalls?
- [ ] Should crashed processes show last error message inline or require `runtime logs`?"


## WebUI & API

### API Endpoint

- FR-10: `GET /api/runtime/services` returns JSON array of all managed sub-processes with status, pid, port, uptime
- FR-11: API response includes `enabledInConfig` boolean for each service (so UI knows if it's disabled vs crashed)
- FR-12: API must timeout within 2 seconds (same as CLI)

### WebUI

- FR-13: Runtime/Services panel on Settings or dedicated page showing all sub-processes
- FR-14: Each service shows status indicator (green dot = running, gray = stopped, red = error)
- FR-15: Services that are disabled in config show toggle to enable via `config toggle` equivalent
- FR-16: Real-time status updates via SSE when service state changes (start/stop/crash)

### Scenarios

### Scenario 5: WebUI shows services
**Given** user opens Runtime page in browser
**When** OpenCode is running and LSP is stopped
**Then** UI shows OpenCode with green indicator and LSP with gray indicator + "disabled" label

### Scenario 6: API response
**Given** client calls `GET /api/runtime/services`
**Then** response is JSON: `{ "services": [{ "name": "opencode", "status": "running", "pid": 12345, "port": 4096, "uptime": "2h30m", "enabledInConfig": true }, ...] }`
