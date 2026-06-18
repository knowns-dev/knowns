---
title: LSP Runtime Wrapper and Managed Backends
description: 'Specification for an LSP runtime wrapper, managed language server dependencies, and multi-backend C# support in Knowns'
createdAt: '2026-06-15T04:09:00.461Z'
updatedAt: '2026-06-15T04:28:19.343Z'
tags:
  - spec
  - draft
  - lsp
  - runtime
  - code-intelligence
  - csharp
  - webui
---

## Overview

Knowns will evolve its current `internal/lsp` implementation into a robust LSP runtime wrapper for project-scoped language-server sessions. The runtime will manage backend selection, dependency installation, lifecycle, logs, indexing readiness, cleanup, and user-facing status across MCP, CLI, API, and the existing Knowns WebUI.

The wrapper/runtime is the canonical execution path for all LSP-backed language adapters in Knowns. C# is the first high-complexity rollout because it needs managed dependencies and multiple backend implementations, but Go, TypeScript, Python, Rust, C/C++, Java, Ruby, PHP, SCSS/CSS, Dart, npm-based servers, user-contributed adapters, and future language adapters must all run through the same runtime/session layer.

The first high-value backend expansion is C# support. C# will support multiple backend implementations: Microsoft Roslyn Language Server, `csharp-ls`, and OmniSharp. The runtime design must be generic enough to support future multi-backend language adapters without creating a parallel LSP system.

## Locked Decisions

- D1: The spec covers all three layers: stabilizing the current `internal/lsp` runtime/session layer, supporting multiple C# backends, and designing a reusable wrapper abstraction for managed language-server sessions.
- D2: The default C# backend behavior is auto-detect, with explicit user override available.
- D3: C# backend auto-detect priority is Roslyn LS, then `csharp-ls`, then OmniSharp, with fallback when a backend is unavailable or cannot start/load the project.
- D4: Configuration uses a multi-layer model: global defaults plus project overrides plus per-language/backend settings, with clear precedence.
- D5: Knowns will support full managed install: download/manage language server dependencies such as Roslyn LS from NuGet, manage versions/runtime dependencies, and bootstrap required runtimes such as .NET 10 when missing.
- D6: For C# repos with multiple `.sln` files, Knowns will auto-select the first `.sln`/`.slnx` found by breadth-first scan, fallback to the first `.csproj`, log the chosen file, and allow config override.
- D7: Backward compatibility with the current `csharp-ls` default is not a primary requirement; the new runtime can change C# behavior to prioritize a stronger design.
- D8: Observability is dashboard-ready inside the existing Knowns WebUI, not a standalone dashboard.
- D9: WebUI scope includes full runtime administration: status, backend/solution/version/path config, restart, install/update dependencies, live logs, and RPC trace viewing.
- D10: MCP/API/CLI status surfaces expose runtime state, including selected backend, install state, selected solution/project, log path, and actionable remediation.
- D11: The runtime wrapper is mandatory for all LSP-backed languages, not only C#. Existing language adapters must migrate to the wrapper/session layer so lifecycle, config, observability, and protocol handling are consistent across languages.
- D12: User-contributed/plugin adapters are acceptable, but they must register into the same runtime wrapper contract rather than bypassing it.
- D13: npm-based language servers and version cleanup are part of the same managed dependency lifecycle and must be surfaced through WrapperLSP/runtime status, install/update, and cleanup flows.
- D14: Dart support is in scope for the shared runtime wrapper and should use the Dart SDK language server through the same lifecycle, config, status, logs, restart, and managed dependency surfaces as other LSP-backed languages.
- D15: WrapperLSP uses a language/backend port table as the canonical registry for every LSP integration. Each port maps a language/backend to detection, dependencies, launch, initialization, project discovery, capabilities, lifecycle hooks, observability, and cleanup metadata.
- D16: Tree-sitter is not part of the current code-intelligence execution path for this spec. WrapperLSP and the managed LSP runtime are the canonical source for symbol, diagnostic, definition, reference, and editing behavior.

## Requirements

### Functional Requirements

- FR-1: Knowns MUST introduce a project-scoped LSP runtime/session abstraction that owns language server lifecycle, file synchronization, JSON-RPC request/notification handling, readiness, diagnostics cache, and shutdown.
- FR-2: The runtime abstraction MUST be generic across languages and MUST not be implemented as a C#-only special case.
- FR-3: Existing language adapters MUST be migrated or wrapped behind the new runtime/session abstraction without creating two competing LSP stacks.
- FR-4: All current and future LSP-backed languages MUST use the runtime/session abstraction as the canonical execution path for MCP `code.*`, CLI, API, and WebUI status.
- FR-5: Language-specific adapters MUST provide only language/backend metadata and hooks, such as file extensions, install requirements, launch command, initialization options, ignored dirs, symbol normalization, project discovery, and capability quirks.
- FR-6: Shared behavior such as process lifecycle, clean MCP stdio logging, request correlation, notification handling, diagnostics caching, readiness, restart, tracing, status, install/update/cleanup, and WebUI log integration MUST live in the runtime/session layer.
- FR-7: User-contributed adapters MAY be loaded from a plugin directory such as `~/.knowns/lsp-adapters/`, but plugin adapters MUST declare runtime-compatible metadata and MUST be executed through the same wrapper/session layer as built-in adapters.
- FR-8: Plugin adapters MAY override built-in adapters by language/backend ID only through the normal adapter registry and config precedence rules.
- FR-9: npm-based servers such as TypeScript, PHP/Intelephense, Bash, SCSS/CSS, and future npm-distributed servers MUST use the same managed dependency install/update/status/cleanup model as other runtime dependencies.
- FR-10: Dart MUST be supported as an LSP-backed language through the shared runtime wrapper, using the Dart SDK language server when available.
- FR-11: Dart runtime settings MUST support SDK path/version metadata, project root detection, analysis options awareness where applicable, restart, status, logs, and optional managed SDK install/update if Knowns supports managed Dart dependencies.
- FR-12: `knowns lsp cleanup` or its successor MUST clean old managed dependency versions only after a newer version is successfully installed and selected by the runtime.
- FR-13: C# MUST support at least three backend identifiers: `roslyn-ls`, `csharp-ls`, and `omnisharp`.
- FR-14: C# backend selection MUST support `auto` mode with priority: Roslyn LS, `csharp-ls`, OmniSharp.
- FR-15: C# backend selection MUST support explicit override at project level and global default level.
- FR-16: Config resolution MUST support global defaults, project overrides, and per-language/backend settings with documented precedence.
- FR-17: The C# runtime MUST discover `.sln`, `.slnx`, and `.csproj` files by breadth-first scan and select the first `.sln`/`.slnx`, then first `.csproj` when no solution exists.
- FR-18: The C# runtime MUST expose a config override for selected solution/project path.
- FR-19: The Roslyn LS backend MUST support managed download from NuGet for supported platforms.
- FR-20: Managed dependency install MUST support pinned versions, cached installs, integrity verification when known checksums are available, and user override of dependency URLs/packages for private mirrors.
- FR-21: Managed runtime bootstrap MUST support .NET 10+ detection and automatic install/bootstrap when missing, with clear logs and remediation on failure.
- FR-22: `csharp-ls` backend MUST launch according to its actual CLI contract and MUST NOT pass unsupported `--stdio` args.
- FR-23: The LSP process lifecycle MUST keep long-running servers alive after startup timeout contexts complete.
- FR-24: The runtime MUST handle server-to-client notifications and requests needed by modern language servers, including progress, log messages, workspace configuration, capability registration, and project initialization notifications.
- FR-25: MCP `code.*` errors MUST include actionable runtime diagnostics when the failure is caused by missing dependencies, backend startup failure, project load failure, indexing timeout, or unsupported capability.
- FR-26: `initial`, `project.status`, and `lsp list` MUST expose selected backend, backend source, install state, running state, selected solution/project, readiness/indexing state, and log path.
- FR-27: The WebUI MUST display LSP runtime status per language/backend for the active project.
- FR-28: The WebUI MUST allow users to edit LSP runtime config, including backend selection, solution/project override, version override, path override, and dependency URL override where supported.
- FR-29: The WebUI MUST allow users to install/update managed dependencies, clean old dependency versions, and restart language servers.
- FR-30: The WebUI MUST provide access to live logs and optional RPC trace logs for LSP runtime debugging.
- FR-31: The CLI MUST provide commands or flags to inspect runtime state, install/update dependencies, cleanup old versions, restart language servers, and locate logs.
- FR-32: The runtime MUST persist logs under a predictable Knowns-managed location and avoid writing protocol logs to stdout in MCP stdio mode.
- FR-33: Runtime status and logs MUST make fallback decisions visible, including attempted backends and why each backend was skipped or failed.
- FR-34: Tree-sitter MUST NOT be required for the WrapperLSP code-intelligence path. Symbol, diagnostic, definition, reference, and edit operations in this spec MUST be served by LSP/runtime capabilities or return a structured unsupported-capability error.

### Non-Functional Requirements

- NFR-1: MCP stdio transport MUST remain clean JSON-RPC; logs and progress output MUST go to stderr or log files only.
- NFR-2: LSP startup and dependency install failures MUST be deterministic and actionable, not generic EOF errors.
- NFR-3: Managed downloads MUST support restricted-network users through configurable mirrors/URLs.
- NFR-4: Runtime implementation MUST avoid blocking normal MCP operations indefinitely while language servers index large workspaces.
- NFR-5: Runtime state updates MUST be safe for concurrent MCP/API/WebUI calls.
- NFR-6: The design MUST keep language-specific behavior in adapters/backends and shared protocol/lifecycle behavior in the runtime/session layer.
- NFR-7: Tests MUST cover lifecycle, backend selection, config precedence, managed dependency resolution, plugin adapter loading, npm dependency install/cleanup, Dart SDK language server launch, and protocol notification/request handling.
- NFR-8: The migration of non-C# languages MUST preserve their existing user-facing capabilities while moving shared behavior into the wrapper/session layer.

## Acceptance Criteria

- [ ] AC-1: A new runtime/session abstraction exists and all MCP `code.*` LSP actions use it rather than directly managing raw server process state.
- [ ] AC-2: Starting a language server with a startup timeout does not kill the process after successful initialization.
- [ ] AC-3: All existing LSP-backed languages run through the wrapper/session layer for lifecycle, status, logs, tracing, dependency install/cleanup, and MCP `code.*` actions.
- [ ] AC-4: Language-specific adapters no longer duplicate shared lifecycle/protocol/logging/install behavior that belongs in the wrapper/session layer.
- [ ] AC-5: User-contributed adapters load through the normal adapter registry and execute through the same wrapper/session layer as built-in adapters.
- [ ] AC-6: npm-based language server installs expose version, source, cache path, cleanup eligibility, and errors through runtime status.
- [ ] AC-7: Dart files are served by the Dart SDK language server through the shared runtime wrapper, with status/logs/restart surfaced through CLI, MCP/API, and WebUI.
- [ ] AC-8: Cleanup removes old managed dependency versions only after a newer version has been successfully installed and selected.
- [ ] AC-9: C# `auto` backend selection attempts Roslyn LS, then `csharp-ls`, then OmniSharp, and records each attempt in runtime status/logs.
- [ ] AC-10: A project can explicitly pin C# backend to `roslyn-ls`, `csharp-ls`, or `omnisharp`.
- [ ] AC-11: Global LSP defaults are overridden by project LSP settings, and tests verify precedence.
- [ ] AC-12: Roslyn LS managed install downloads/caches the correct platform package and launches through `dotnet` when .NET 10+ is available.
- [ ] AC-13: When .NET 10+ is missing, Knowns attempts configured runtime bootstrap or returns an actionable install failure with log path.
- [ ] AC-14: In a repo with multiple `.sln` files, Knowns selects the first `.sln`/`.slnx` by breadth-first scan unless config overrides it.
- [ ] AC-15: MCP `code.symbols` on a C# file returns symbols or a structured actionable error; it must not return bare `EOF` for known startup/load failures.
- [ ] AC-16: `project.status`, `initial`, and `lsp list` include backend, install state, selected solution/project, readiness, and log path for C#.
- [ ] AC-17: WebUI displays per-language runtime state and lets users restart a C# language server.
- [ ] AC-18: WebUI lets users change C# backend and selected solution/project path, then restart/apply the change.
- [ ] AC-19: WebUI can trigger managed install/update/cleanup for LSP dependencies and display progress/failure.
- [ ] AC-20: WebUI can show live logs and optional RPC trace for the active LSP runtime.
- [ ] AC-21: Protocol tests cover interleaved notifications, server-to-client requests, progress events, diagnostics notifications, and normal request responses.
- [ ] AC-22: Code-intelligence tests prove WrapperLSP does not require tree-sitter by running supported symbol/diagnostic/definition/reference operations through LSP-only runtime paths.

## Scenarios

### Scenario 1: Any LSP Language Uses the Shared Runtime

**Given** a project with Go, TypeScript, Python, Dart, or C# files
**When** Knowns starts code intelligence for that language
**Then** the language server is managed by the shared runtime/session layer
**And** status, logs, restart behavior, tracing, diagnostics cache, and MCP protocol handling use the same infrastructure.

### Scenario 2: Dart SDK Language Server Uses Shared Runtime

**Given** a Dart project with `.dart` files and a Dart SDK available or managed by Knowns
**When** Knowns starts Dart code intelligence
**Then** it launches the Dart SDK language server through the shared runtime/session layer
**And** `code.symbols`, status, logs, restart, and dependency state are surfaced consistently with other languages.

### Scenario 3: npm-Based Language Server Uses Managed Runtime Dependencies

**Given** a TypeScript, PHP, Bash, or SCSS/CSS language server distributed through npm
**When** Knowns installs, updates, starts, or cleans that language server
**Then** the action runs through the shared runtime dependency lifecycle
**And** status/WebUI/CLI show version, source, install path, and cleanup state.

### Scenario 4: User-Contributed Adapter Uses Wrapper Runtime

**Given** a user adds an adapter manifest under the plugin adapter directory
**When** Knowns loads adapters at startup
**Then** the plugin adapter is registered through the normal adapter registry
**And** any server process launched from it uses the shared runtime/session layer.

### Scenario 5: C# Auto-Detect Happy Path with Roslyn LS

**Given** a C# repo with `.sln` files and no project override
**When** the user starts Knowns MCP or opens the WebUI
**Then** Knowns resolves C# backend `auto` to Roslyn LS when .NET 10+ and Roslyn LS are available or installable
**And** `code.symbols` returns C# symbols through the runtime session
**And** `project.status` shows backend `roslyn-ls`, selected solution/project, readiness, and log path.

### Scenario 6: Roslyn LS Unavailable, Fallback to csharp-ls

**Given** C# backend is `auto`
**And** Roslyn LS cannot be installed or launched
**And** `csharp-ls` is available
**When** Knowns starts C# code intelligence
**Then** Knowns falls back to `csharp-ls`
**And** runtime status records the failed Roslyn attempt and selected `csharp-ls` backend.

### Scenario 7: Explicit Backend Override

**Given** project config pins C# backend to `omnisharp`
**When** Knowns starts C# code intelligence
**Then** Knowns uses OmniSharp only
**And** it does not silently fall back to another backend unless the config explicitly permits fallback.

### Scenario 8: Multiple Solutions

**Given** a repo contains `eShopOnWeb.sln` and `Everything.sln`
**When** no solution override is configured
**Then** Knowns selects the first `.sln`/`.slnx` found by breadth-first scan
**And** logs the selected solution
**And** displays it in CLI/MCP/WebUI status.

### Scenario 9: Missing Runtime Dependency

**Given** Roslyn LS is selected
**And** .NET 10+ is missing
**When** managed runtime bootstrap is enabled
**Then** Knowns attempts to bootstrap .NET 10+
**And** reports install progress and failure details in logs/WebUI
**And** MCP returns an actionable error if bootstrap fails.

### Scenario 10: MCP Stdio Safety

**Given** Knowns is running as an MCP stdio server
**When** an LSP backend emits logs, progress, or trace data
**Then** Knowns writes those details to stderr/log files/WebUI streams
**And** stdout remains valid MCP JSON-RPC only.

### Scenario 11: WebUI Runtime Administration

**Given** a C# project is active in Knowns WebUI
**When** the user opens LSP runtime settings
**Then** they can see selected backend, attempted backends, dependency state, selected solution/project, readiness, restart status, log path, and RPC trace controls
**And** they can edit backend/solution/version/path settings and restart/apply changes.

## Technical Notes

- Existing code areas likely affected: `internal/lsp`, `internal/lsp/adapters`, `internal/mcp/handlers/code.go`, readiness/status reporting, CLI `lsp` commands, server routes for LSP/WebUI, and WebUI settings/status screens.
- Existing specs to preserve conceptually: @doc/specs/lsp-enriched-code-intelligence, @doc/specs/advanced-lsp-language-support, @doc/specs/spec-lsp-language-hot-add-from-webui, @doc/specs/runtime-process-dashboard, and @doc/specs/remove-tree-sitter-lsp-only-code-intelligence.
- Tree-sitter removal from @doc/specs/remove-tree-sitter-lsp-only-code-intelligence remains in force for this design: WrapperLSP should not introduce a second AST-backed code-intelligence path.
- Plugin adapter support from @doc/specs/advanced-lsp-language-support should register adapters into the wrapper runtime rather than bypass it.
- npm-based server install behavior from @doc/specs/advanced-lsp-language-support should move into the same managed dependency lifecycle as other runtime backends.
- Cleanup behavior from @doc/specs/advanced-lsp-language-support should remain, but cleanup state should be runtime-aware and only remove old versions after successful newer installs.
- Dart should use the Dart SDK language server, with SDK path/version information visible through runtime status and configurable through the same global/project settings model.
- Reference behavior captured in this spec: global plus project config, per-language settings, managed Roslyn LS from NuGet, .NET 10+ requirement/bootstrap, first solution breadth-first selection, and WebUI/log observability.
- C# Roslyn LS should handle required server-to-client requests such as `workspace/configuration`, `window/workDoneProgress/create`, `client/registerCapability`, and Roslyn project initialization notifications.
- RPC tracing should be opt-in because traces may be verbose and may include source content.

## Open Questions

- [ ] OQ-1: What exact config schema names should Knowns use for global/project LSP settings?
- [ ] OQ-2: Should explicit backend pinning fail closed by default, or allow fallback with a separate `fallback: true` setting?
- [ ] OQ-3: Which platforms and checksums should be included for the first Roslyn LS managed install implementation?
- [ ] OQ-4: Should .NET runtime bootstrap be enabled by default, or require explicit opt-in for security/network control?
- [ ] OQ-5: Should Dart SDK install/update be managed by Knowns in the first implementation, or should the first Dart adapter require an existing SDK path/PATH entry?


## Language Port Table

WrapperLSP MUST expose a language/backend port table that acts as the canonical registry for all supported language-server integrations. The table is conceptually similar to a cross-language LSP client registry: each row maps one language/backend to the metadata and hooks required for install, launch, initialization, project discovery, request capability support, and status reporting.

The port table MUST be data-driven enough that adding a language does not require duplicating lifecycle or protocol code. Built-in adapters, managed backends, and user-contributed adapters all register through this table.

Each port table entry MUST support these fields or equivalent structured data:

- `language_id`: stable Knowns language ID, such as `go`, `typescript`, `csharp`, or `dart`.
- `backend_id`: stable backend ID, such as `gopls`, `typescript-language-server`, `roslyn-ls`, `csharp-ls`, `omnisharp`, or `dart-sdk-lsp`.
- `display_name`: human-readable language/backend label.
- `extensions`: file extensions handled by the port.
- `priority`: auto-detect priority within the language.
- `detect`: project/file detection rules.
- `dependencies`: runtime and language-server dependencies, including managed install metadata.
- `launch`: command, args, env, working directory, and transport settings.
- `initialize`: initialization params/options and server-specific capability configuration.
- `project`: project discovery hooks, such as solution/project file selection for C# or SDK root detection for Dart.
- `capabilities`: supported LSP operations and known limitations.
- `normalization`: symbol name/signature normalization hooks.
- `ignored_dirs`: language/backend-specific ignored directories.
- `lifecycle_hooks`: optional hooks for post-initialize notifications, project open notifications, indexing readiness, and server-specific requests.
- `observability`: log file locations, RPC trace support, status fields, install progress, and actionable remediation templates.
- `cleanup`: version retention and cleanup eligibility rules.

The runtime/session layer MUST consume this port table to construct language-server sessions. MCP, CLI, API, and WebUI status MUST report the selected `language_id`, `backend_id`, source, dependency state, selected project metadata, readiness, logs, and fallback attempts from the same port table/runtime state.

This port table design is added to the locked decisions as D15: WrapperLSP uses a language/backend port table as the canonical registry for every LSP integration.
