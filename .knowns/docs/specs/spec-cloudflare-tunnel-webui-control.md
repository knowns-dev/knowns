---
title: 'Spec: Cloudflare Tunnel WebUI Control'
description: Spec for controlling Cloudflare Tunnel from WebUI settings and CLI status output
createdAt: '2026-05-28T08:44:16.878Z'
updatedAt: '2026-05-28T08:44:16.878Z'
tags:
  - spec
  - tunnel
  - webui
  - cloudflare
---

# Spec: Cloudflare Tunnel WebUI Control

## Overview

Allow users to start/stop Cloudflare Tunnel from WebUI settings page, view the public URL, and see status updates in both UI and CLI terminal.

## Background

- `cloudflared.Daemon` already handles spawn/stop/health/URL capture (`internal/tunnel/cloudflared/daemon.go`)
- CLI `knowns browser --tunnel` starts tunnel before server (`internal/cli/browser.go:328-347`)
- Service status monitor already detects running tunnels via SSE `service:status` events (`internal/services/status.go:328-421`)
- Server broadcasts SSE events via `SSEBroker` (`internal/server/sse.go`)

## Requirements

### WebUI Settings Section

- Add "Tunnel" section in ConfigPage (under Advanced or as its own tab)
- Show toggle: Start / Stop tunnel
- When running: display public URL (copyable), uptime, status indicator (green dot)
- When stopped: show "Not running" with Start button
- When `cloudflared` not installed: show install instructions

### API Endpoints

- `POST /api/tunnel/start` — calls `daemon.EnsureRunning()`, returns `{ url, status }`
- `POST /api/tunnel/stop` — calls `daemon.Stop()`, returns `{ status: "stopped" }`
- `GET /api/tunnel/status` — returns `{ running: bool, url?: string, pid?: int, startedByUs?: bool }`

### Server Integration

- Server struct holds `*cloudflared.Daemon` reference (lazy-init on first start)
- Tunnel lifecycle managed by server, not just CLI
- On tunnel start/stop, broadcast SSE event `tunnel:status` with `{ running, url }`
- If `--tunnel` flag used on CLI, server auto-starts tunnel at boot (existing behavior preserved)

### CLI Status Output

- When tunnel starts (from CLI or WebUI trigger): print to CLI terminal
  ```
  ✓ Tunnel active: https://xxx-yyy.trycloudflare.com
  ```
- When tunnel stops: print
  ```
  ✗ Tunnel stopped
  ```
- Use existing `StyleSuccess` / `StyleWarning` patterns from `internal/cli/styles.go`
- CLI receives tunnel events via the same SSE stream it already monitors for service status

### Error Handling

- `cloudflared` not found → return 400 with install instructions
- Tunnel fails to start (timeout 20s) → return 500 with log file path
- Tunnel already running → return current URL (idempotent)
- Stop when not running → return success (idempotent)

## Non-Goals

- Named tunnels (only Quick Tunnels / trycloudflare.com)
- Persisting tunnel state to config (tunnel is ephemeral, session-only)
- Auth/password (separate spec)

## Acceptance Criteria

- [ ] User can start tunnel from WebUI settings
- [ ] User can stop tunnel from WebUI settings
- [ ] Public URL displayed in UI when tunnel is running
- [ ] CLI terminal prints tunnel URL when started (from any source)
- [ ] CLI terminal prints when tunnel stops
- [ ] SSE event `tunnel:status` broadcast on state changes
- [ ] Error shown in UI if cloudflared not installed
- [ ] Existing `--tunnel` CLI flag continues to work
- [ ] Tunnel status visible in runtime services panel
