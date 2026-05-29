---
title: 'Spec: LSP Language Hot-Add from WebUI'
description: Spec for adding LSP languages from WebUI with hot-reload and CLI status output
createdAt: '2026-05-28T08:45:19.270Z'
updatedAt: '2026-05-28T08:45:19.270Z'
tags:
  - spec
  - lsp
  - webui
  - hot-reload
---

# Spec: LSP Language Hot-Add from WebUI

## Overview

Allow users to add new LSP languages from WebUI settings without restarting the server. When a language is added, the LSP server starts immediately. CLI terminal prints status updates for all LSP config changes.

## Background

- LSP Manager supports `RegisterAdapter()` and per-language start (`internal/lsp/manager.go`)
- 10 adapters available: go, typescript, python, rust, c_cpp, java, csharp, ruby, php, scss (`internal/lsp/adapters/adapters.go:6-19`)
- Config uses free-form `map[string]LSPLanguageSettings` — accepts any language ID (`internal/models/config.go:18-28`)
- Current UI only shows toggles for already-detected languages, hidden if none exist (`ui/src/pages/ConfigPage.tsx:812`)
- Service status monitor broadcasts `service:status` SSE events every 7s (`internal/server/server.go:558-593`)
- No hot-reload mechanism exists — LSP config read once at startup

## Requirements

### WebUI Settings — Code Section

- Always show LSP languages section (remove `languageEntries.length > 0` guard)
- Show existing languages with enable/disable toggle (current behavior)
- Add "Add Language" control:
  - Dropdown listing all available adapters from registry (go, typescript, python, rust, c_cpp, java, csharp, ruby, php, scss)
  - Only show languages not already configured
  - Selecting a language adds it with `{ enabled: true }` immediately
- When a language is added: it becomes active immediately (no restart needed)
- Show per-language status indicator: running (green), starting (yellow), not installed (red with install hint)

### API Endpoints

- `POST /api/lsp/languages` `{ language: "rust" }` — add language, start LSP server, return status
- `DELETE /api/lsp/languages/:lang` — disable and stop LSP server for language
- `PUT /api/lsp/languages/:lang` `{ enabled: bool }` — toggle language, start/stop accordingly
- `GET /api/lsp/languages` — list all available adapters with current status (configured, running, not-installed)

### Server-Side Hot-Reload

- When language added via API:
  1. Update project config in-memory and persist to `config.json`
  2. If LSP Manager exists: call `StartLanguage(lang)` (new method) to start the server immediately
  3. Broadcast SSE event `lsp:language` with `{ language, status, action: "added"|"removed"|"toggled" }`
- When language removed/disabled:
  1. Update config
  2. Stop the language server gracefully
  3. Broadcast SSE event

### LSP Manager Changes

- Add `StartLanguage(ctx, lang string) error` method:
  - Find registered adapter for language
  - Check binary exists (return install hint if not)
  - Start server for that language
  - Return error or nil
- Add `StopLanguage(lang string) error` method:
  - Gracefully shutdown the language server
  - Remove from active servers map
- Add `AvailableLanguages() []LanguageInfo` method:
  - Return all registered adapters with install status

### CLI Status Output

- When LSP language starts (from any source): print to CLI terminal
  ```
  ✓ LSP: rust-analyzer started (rust)
  ```
- When LSP language stops: print
  ```
  ✗ LSP: rust-analyzer stopped (rust)
  ```
- When language added but binary not found: print
  ```
  ⚠ LSP: rust-analyzer not installed (rust) — install with: rustup component add rust-analyzer
  ```
- Use existing `StyleSuccess` / `StyleWarning` / `StyleError` patterns

### Config Persistence

- Language additions persist to `config.json` under `lsp.languages`
- This is different from password (in-memory only) — LSP config is project-level and should survive restart
- On next server start, configured languages auto-start as before

## Non-Goals

- Custom language server binary paths from WebUI (CLI-only for now)
- Auto-detecting new languages at runtime (only manual add from UI)
- Language server configuration beyond enable/disable (advanced config stays in config.json)

## Acceptance Criteria

- [ ] WebUI shows "Add Language" dropdown in Code settings section
- [ ] User can add a new language from the dropdown
- [ ] Added language LSP server starts immediately without restart
- [ ] User can disable a running language (server stops)
- [ ] User can re-enable a disabled language (server starts)
- [ ] CLI prints status when LSP servers start/stop
- [ ] CLI prints warning with install hint if binary not found
- [ ] Language config persists to config.json
- [ ] On server restart, previously added languages auto-start
- [ ] SSE event broadcast on language status changes
- [ ] UI shows per-language status (running/stopped/not-installed)
- [ ] Languages section visible even when no languages configured yet
