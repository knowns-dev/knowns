---
id: doc-8f8e0a05dcdade4346622b1eee239be6
title: Knowns Go Rewrite
createdAt: "2026-03-06T04:12:36.486Z"
updatedAt: "2026-03-06T04:17:04.041Z"
description: Specification for rewriting Knowns from Node/TypeScript to Go
tags:
  - spec
  - approved
---

## Overview

Rewrite Knowns CLI, MCP server, and HTTP server from Node.js/TypeScript to Go. The React UI remains unchanged (built with Vite, served as static assets by Go HTTP server). The npm distribution model is preserved — Go binary shipped via npm packages per platform.

### Goals

- Single binary distribution (no Node.js runtime dependency)
- Instant startup (no cold start)
- Easy cross-compilation (darwin/linux/windows × amd64/arm64)
- Maintain full feature parity with current TypeScript implementation
- Preserve npm install experience (`npx knowns`, `npx knowns mcp`)

### Non-Goals

- Rewriting the React UI (kept as-is, built separately with Vite)
- Changing the `.knowns/` data format (JSON/Markdown files stay the same)
- Changing the MCP protocol or tool signatures

---

## Requirements

### Functional Requirements

- FR-1: CLI commands — full parity with current Commander.js CLI (task, doc, time, search, config, init, validate, template, skill, import, browser, mcp)
- FR-2: MCP server — all current MCP tools working via stdio transport (detect_projects, set_project, get_current_project, create/get/update/list tasks, create/get/update/list docs, search, time tracking, templates, validate, get_board)
- FR-3: HTTP server — Express 5 equivalent with SSE events, WebSocket for workspace terminal streaming, REST API for all resources
- FR-4: Storage layer — read/write `.knowns/` directory structure (tasks, docs, templates, config, time entries) — same JSON/Markdown format
- FR-5: Semantic search — ONNX-based embedding via Hugot, compatible with existing search index
- FR-6: Template engine — Handlebars-compatible template rendering for code generation
- FR-7: Agent-proxy — merge current Go binary into main binary as a subcommand or internal module
- FR-8: npm distribution — publish prebuilt binaries via `optionalDependencies` per platform pattern (like esbuild)
- FR-9: Skill sync — sync `.knowns/skills/` to platform-specific directories (Claude Code, OpenCode)
- FR-10: Auto-sync — detect CLI version changes and re-sync skills/instructions
- FR-11: Init wizard — interactive project initialization with prompts
- FR-12: WebUI — serve Vite-built React static assets, same UI features

### Non-Functional Requirements

- NFR-1: Binary size < 30MB (without embedded UI assets)
- NFR-2: Startup time < 100ms for CLI commands
- NFR-3: Cross-compile to 6 targets: darwin-arm64, darwin-x64, linux-arm64, linux-x64, windows-arm64, windows-x64
- NFR-4: Zero runtime dependencies — single static binary
- NFR-5: Backward compatible `.knowns/` data — existing projects work without migration
- NFR-6: npm package size < 15MB per platform package

---

## Acceptance Criteria

- [x] AC-1: All CLI commands pass existing e2e tests (adapted for Go binary)
- [x] AC-2: All MCP tools pass existing MCP e2e tests
- [x] AC-3: `npx knowns` installs and runs Go binary correctly on macOS, Linux, Windows
- [x] AC-4: `knowns browser` serves WebUI with full functionality (SSE, WebSocket, REST API)
- [x] AC-5: Semantic search produces equivalent results to current JS implementation
- [x] AC-6: Template engine renders existing `.knowns/templates/` correctly
- [x] AC-7: Workspace agent system (agent-proxy) works as integrated module
- [x] AC-8: `knowns init` creates identical `.knowns/` structure and platform configs
- [x] AC-9: Existing projects with `.knowns/` directory work without any migration step
- [x] AC-10: CI/CD pipeline builds and publishes npm packages for all 6 platforms

---

## Architecture

### Go Module Structure

```
knowns/
├── cmd/
│   └── knowns/
│       └── main.go              # Entry point
├── internal/
│   ├── cli/                     # Cobra commands
│   │   ├── root.go
│   │   ├── task.go
│   │   ├── doc.go
│   │   ├── time.go
│   │   ├── search.go
│   │   ├── config.go
│   │   ├── init.go
│   │   ├── validate.go
│   │   ├── template.go
│   │   ├── skill.go
│   │   ├── import.go
│   │   ├── browser.go
│   │   └── mcp.go
│   ├── storage/                 # .knowns/ file I/O
│   │   ├── task_store.go
│   │   ├── doc_store.go
│   │   ├── config_store.go
│   │   ├── time_store.go
│   │   └── template_store.go
│   ├── models/                  # Data structures
│   │   ├── task.go
│   │   ├── doc.go
│   │   ├── config.go
│   │   └── template.go
│   ├── mcp/                     # MCP server (mcp-go)
│   │   ├── server.go
│   │   └── handlers/
│   ├── server/                  # HTTP + SSE + WS
│   │   ├── server.go
│   │   ├── routes/
│   │   ├── sse.go
│   │   └── workspace/
│   ├── search/                  # Semantic search (Hugot/ONNX)
│   │   ├── engine.go
│   │   └── index.go
│   ├── codegen/                 # Template engine + skill sync
│   │   ├── template_engine.go
│   │   └── skill_sync.go
│   └── util/                    # Shared utilities
├── ui/                          # React UI (unchanged)
│   ├── src/
│   └── dist/                    # Built assets, embedded via go:embed
├── npm/                         # npm publishing
│   ├── knowns/                  # Main package (JS wrapper)
│   │   ├── package.json
│   │   └── bin/knowns.js
│   ├── knowns-darwin-arm64/
│   ├── knowns-darwin-x64/
│   ├── knowns-linux-arm64/
│   ├── knowns-linux-x64/
│   ├── knowns-win-arm64/
│   └── knowns-win-x64/
├── go.mod
├── go.sum
└── Makefile
```

### Key Go Libraries

| Purpose             | Library                                     |
| ------------------- | ------------------------------------------- |
| CLI framework       | `github.com/spf13/cobra`                    |
| Interactive prompts | `github.com/charmbracelet/huh`              |
| Terminal styling    | `github.com/charmbracelet/lipgloss`         |
| MCP server          | `github.com/mark3labs/mcp-go`               |
| HTTP router         | `github.com/go-chi/chi/v5`                  |
| WebSocket           | `github.com/gorilla/websocket`              |
| YAML                | `gopkg.in/yaml.v3`                          |
| Markdown            | `github.com/yuin/goldmark`                  |
| Semantic search     | `github.com/knights-analytics/hugot` (ONNX) |
| Embed static        | `embed` (stdlib)                            |
| Template            | `text/template` (stdlib)                    |

### npm Distribution

```
npm install knowns
  → installs knowns (main) + @knowns/darwin-arm64 (platform-specific)

npx knowns task list
  → bin/knowns.js resolves Go binary path → execFileSync(binary, args)
```

---

## Migration Phases

### Phase 1: Core Foundation

- Go project scaffold, CI/CD
- Storage layer (read/write .knowns/)
- Models (task, doc, config, template)
- Basic CLI commands: task, doc, config

### Phase 2: Full CLI

- All remaining CLI commands
- Init wizard
- Template engine
- Skill sync
- Validate

### Phase 3: MCP Server

- MCP server with all handlers
- stdio transport
- Session/project management

### Phase 4: HTTP Server + WebUI

- REST API routes
- SSE events
- WebSocket terminal
- Workspace/agent system (merge agent-proxy)
- Embed and serve React UI

### Phase 5: Search + Polish

- Semantic search (Hugot/ONNX)
- npm packaging and publishing
- Cross-platform testing
- Performance benchmarks
- Documentation updates

---

## Scenarios

### Scenario 1: Fresh Install

**Given** user has Node.js installed
**When** they run `npm install -g knowns`
**Then** npm installs the JS wrapper + platform-specific Go binary
**And** `knowns --version` outputs version instantly

### Scenario 2: Existing Project

**Given** a project has `.knowns/` directory from TypeScript version
**When** user upgrades to Go version via `npm update knowns`
**Then** all tasks, docs, templates, config work without migration
**And** `knowns task list` shows same data

### Scenario 3: MCP in Claude Code

**Given** `.mcp.json` configured with `npx knowns mcp`
**When** Claude Code starts MCP server
**Then** Go binary starts MCP server via stdio
**And** all MCP tools work identically

### Scenario 4: WebUI

**Given** user runs `knowns browser`
**When** Go HTTP server starts
**Then** React UI loads from embedded static assets
**And** SSE, WebSocket, REST API all functional

---

## Open Questions

- [x] ~~Handlebars → Go text/template~~ → Use `flowchartsman/handlebars` or `steeringwaves/go-handlebars` (active forks of raymond). User templates keep Handlebars syntax, no migration needed.
- [x] ~~Hugot ONNX: bundle or download?~~ → Download on first use (same as current JS implementation with @huggingface/transformers).
- [x] ~~Monorepo or separate repos?~~ → Monorepo (Go + React UI in same repo).
- [x] ~~Transition strategy?~~ → Hard cutover. TypeScript version will not be maintained in parallel.
