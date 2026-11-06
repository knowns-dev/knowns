---
id: doc-d63a6145a0b07ec13a611b243570d13a
title: Runtime Memory Hook Injection
description: Specification for bounded multi-runtime memory injection hooks backed by Knowns memory context builder
createdAt: '2026-04-11T14:30:47.775Z'
updatedAt: '2026-04-11T14:52:43.184Z'
tags:
  - spec
  - approved
  - runtime
  - memory
  - mcp
  - hooks
---

# Runtime Memory Hook Injection

## Overview

Specification for adding bounded memory injection hooks to supported agent runtimes such as Kiro, Claude Code, OpenCode, and Antigravity-compatible adapters.

The goal is to make Knowns memories materially useful during agent execution without requiring every runtime or model to explicitly call `list_memories`, `search`, or `retrieve` before work begins.

The feature must treat memory as supplemental context, not as a replacement for canonical sources such as `KNOWNS.md`, tasks, docs, or source files.

Related docs:
- `KNOWNS.md` (canonical repo guidance)
- @doc/specs/global-runtime-queue-for-mcp-and-background-work
- @doc/patterns/pattern-atlas-chat-runtime
- @doc/knowns-hub/architecture/embedding-ai-providers

## Locked Decisions

- D1: Default injection happens in runtime adapters, not directly in the MCP server. Runtime-specific hooks call a shared Knowns context builder.
- D2: Default injected context is memory-only. Docs, tasks, and retrieval snippets are out of scope for the initial hook payload.
- D3: Default mode is auto-bounded. The hook selects a small relevant memory pack automatically with hard size and count limits.
- D4: `manual` mode is surfaced primarily as a per-request or per-session toggle, with optional command aliases where a runtime supports command surfaces.
- D5: Global memories participate in ranking only after relevant project-scoped memories are considered.
- D6: Ranking reasons are user-visible only in `debug` mode by default.
- D7: Kiro is the first target runtime because it exposes native event hooks and offers the clearest first implementation path.

## Requirements

### Functional Requirements

- FR-1: Knowns must provide a shared memory context builder that runtime adapters can call before model execution.
- FR-2: Supported runtime adapters for the initial rollout must include Kiro, Claude Code, OpenCode, and Antigravity-compatible adapter points where available.
- FR-3: The shared memory context builder must accept runtime metadata including current project, working directory, action type, and optional user prompt text.
- FR-4: The shared memory context builder must return a bounded memory pack containing only memory entries relevant to the current project and request context.
- FR-5: The initial memory pack must only contain memory-derived items such as decisions, patterns, preferences, warnings, or failures.
- FR-6: The memory pack must preserve provenance for each injected item including at least title, category, layer, and updated timestamp.
- FR-7: The memory pack must include an explicit note that memory is supplemental context and does not override canonical guidance from `KNOWNS.md`, source-of-truth docs, tasks, or source files.
- FR-8: The memory pack builder must support ranking memory by request relevance using available signals such as project scope, command/action type, keyword overlap, and recency.
- FR-9: The memory pack builder must enforce hard limits on total injected items and total serialized size.
- FR-10: The hook integration must support runtime-level modes: `off`, `auto`, `manual`, and `debug`.
- FR-11: In `auto` mode, the runtime adapter must inject the bounded memory pack automatically before model execution.
- FR-12: In `manual` mode, the runtime adapter must expose a per-request or per-session toggle to request memory injection explicitly.
- FR-13: In `debug` mode, the runtime adapter must expose the candidate memory pack and ranking reason without silently injecting it.
- FR-14: If no relevant project-scoped memory exists, the hook must inject nothing and continue normally.
- FR-15: The shared memory context builder must prevent cross-project leakage by excluding memories that do not belong to the active project scope unless they are explicitly marked global.
- FR-16: Runtime adapters must make it possible to inspect which memories were injected for the current action.
- FR-17: The initial implementation must not require changes to public Knowns CLI command shapes.
- FR-18: The initial implementation must not mutate docs, tasks, or memories during injection.
- FR-19: Kiro integration must use native event hooks where available instead of wrapper-only fallbacks.
- FR-20: Runtime adapters without native hooks must still be able to use wrapper or adapter-based memory injection where the runtime allows pre-execution context augmentation.

### Non-Functional Requirements

- NFR-1: Memory injection must remain bounded enough to avoid prompt bloat during normal requests.
- NFR-2: Memory injection must degrade gracefully when runtime hooks are unavailable for a platform.
- NFR-3: Ranking and serialization must be deterministic enough that repeated identical requests in the same project produce stable memory packs unless source memories changed.
- NFR-4: Hook behavior must be observable and debuggable by users and developers.
- NFR-5: Memory injection must preserve project isolation even when runtimes are managed from a shared global process.
- NFR-6: The design must allow future expansion to optional doc/task/reference injection without breaking memory-only adapters.

## Acceptance Criteria

- [ ] AC-1: A shared Knowns memory context builder exists and can be called independently of any one runtime implementation.
- [ ] AC-2: Kiro, Claude Code, OpenCode, and at least one additional compatible runtime adapter can request a memory pack through the shared builder.
- [ ] AC-3: In default `auto` mode, a runtime action in a project with relevant memories injects a bounded memory pack before model execution.
- [ ] AC-4: In default `auto` mode, a runtime action in a project with no relevant memories injects nothing and does not error.
- [ ] AC-5: The injected memory pack contains only memory entries and does not inline docs, tasks, or source file contents.
- [ ] AC-6: Each injected memory item includes provenance fields: title, category, layer, and updated timestamp.
- [ ] AC-7: The injected payload includes a canonicality warning stating that memory does not override `KNOWNS.md` or source-of-truth project data.
- [ ] AC-8: Runtime-level `off`, `auto`, `manual`, and `debug` modes are supported.
- [ ] AC-9: In `debug` mode, the runtime can show which memories would be injected and why, without injecting them automatically.
- [ ] AC-10: Hard limits prevent memory injection from exceeding configured item count and size caps.
- [ ] AC-11: Project-scoped injection excludes unrelated project memories unless they are explicitly global.
- [ ] AC-12: The feature can be disabled without affecting normal MCP or CLI behavior.
- [ ] AC-13: Kiro uses native event hooks for the first runtime implementation path.
- [ ] AC-14: Runtimes without native hooks can still integrate through adapter or wrapper-based pre-execution injection where supported.

## Scenarios

### Scenario 1: Auto injection for implementation request
**Given** a project has memories about coding patterns and known pitfalls
**When** a Kiro, Claude Code, or OpenCode runtime starts an implementation action in `auto` mode
**Then** the runtime injects a bounded memory pack with the most relevant project memories before model execution

### Scenario 2: No relevant memory
**Given** the active project has no relevant project or global memories for the request
**When** the runtime asks for a memory pack in `auto` mode
**Then** the shared builder returns no injected memory and the runtime proceeds normally

### Scenario 3: Debug inspection
**Given** a user wants to understand runtime memory behavior
**When** the runtime is set to `debug` mode for the current action
**Then** the adapter displays candidate memory items, ranking reasons, and size estimates without injecting the pack

### Scenario 4: Cross-project safety
**Given** the runtime host has access to multiple projects
**When** a request is executed inside project A
**Then** the injected memory pack excludes project B memories unless an item is explicitly marked global

### Scenario 5: Hook-unavailable platform
**Given** a runtime platform does not expose a usable native pre-execution hook
**When** Knowns is used in that platform
**Then** normal operation continues through adapter or wrapper fallback where supported, or without memory injection where no safe injection surface exists

### Scenario 6: Kiro native hook path
**Given** Kiro supports native event hooks before agent execution
**When** a Kiro project action triggers the configured memory hook in `auto` mode
**Then** Kiro calls the shared Knowns builder, injects the bounded memory pack, and continues with normal agent execution

## Technical Notes

### Shared Builder Contract

The shared builder should accept inputs such as:
- runtime name
- project root
- working directory
- action type or command
- optional user text/query
- mode
- max items
- max bytes

The shared builder should return:
- selected memory items
- ranking reasons or scores
- serialization size estimate
- canonicality warning
- injection status (`none`, `candidate`, `injected`)

### Initial Memory Categories

Initial ranking should support these categories:
- `decision`
- `pattern`
- `preference`
- `warning`
- `failure`

### Suggested Default Limits

Initial defaults should stay small and adjustable:
- max items: 5
- soft serialized target: 1200 to 1800 characters
- hard serialized ceiling: 2500 characters

### Adapter Responsibility Boundary

Runtime adapters are responsible for:
- detecting the active project/runtime context
- calling the shared Knowns builder
- formatting and injecting the returned memory pack according to runtime-specific hook APIs
- exposing inspection/debug output where the platform allows it

Knowns is responsible for:
- memory retrieval and ranking
- project scoping and global-memory handling
- serialization format and provenance
- canonicality warnings and limits

## Open Questions

None for the initial approved scope.
