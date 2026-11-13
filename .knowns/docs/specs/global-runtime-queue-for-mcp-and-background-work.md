---
id: doc-e4a3b88722ea59c4ab599570a6a137b7
title: Global Runtime Queue For MCP And Background Work
description: Specification for a global runtime that centralizes watch, reindex, indexing jobs, and installer-aware self-update while MCP remains fast on read and write paths.
createdAt: '2026-04-11T13:23:13.229Z'
updatedAt: '2026-04-11T15:06:23.110Z'
tags:
  - spec
  - approved
  - runtime
  - mcp
  - queue
  - search
  - install
  - update
---

## Overview

Introduce a single global Knowns runtime managed by `knowns` that acts as a shared coordinator for background work across multiple active projects while keeping user-facing commands stable. MCP remains the public request interface for reads and source-of-truth writes, but heavy work such as semantic indexing, code indexing, watch-triggered updates, and reindex operations is enqueued to the shared runtime instead of running inline in the MCP process.

This runtime is global at the process-management level, but project-owned queue state, search indexes, and source data remain isolated inside each project's `.knowns` directory. The goal is to reduce duplicate workers, reuse runtime resources such as ONNX sessions and watchers, and make MCP request handling faster and more predictable when many files or updates are processed.

The same global runtime layer also needs installer awareness so `knowns update` can recognize when Knowns was installed by the official shell or PowerShell install scripts, apply the correct self-update strategy, and keep runtime lifecycle consistent after the binary changes.

## Locked Decisions

- D1: Use one global runtime process as the shared coordinator for all active projects; project data, queue state, and indexing results remain isolated per project.
- D2: Store runtime state, process leases, sockets, pid files, and logs under `~/.knowns`, while keeping project job queues and search/index data inside each project's `.knowns` directory.
- D3: MCP keeps direct synchronous reads and source-of-truth writes, but moves indexing, watch-triggered work, and reindex operations to runtime-managed queue execution.
- D4: Official install scripts record install metadata under `~/.knowns`, and `knowns update` uses that metadata to choose the correct update behavior instead of guessing from PATH or shell history.

## Requirements

### Functional Requirements

- FR-1: `knowns` remains the only public CLI entrypoint. Users must not need to invoke runtime worker binaries directly.
- FR-2: The system must provide a single global runtime process that can coordinate background work for multiple projects concurrently.
- FR-3: `knowns` commands that need runtime services must detect whether the global runtime is already running and connect to it when available.
- FR-4: If the global runtime is not running, `knowns` must start it through an internal/private execution path rather than requiring a separate user-managed command.
- FR-5: The runtime must maintain per-project execution context so background jobs for one project do not read from or write to another project's `.knowns` data.
- FR-6: Runtime-managed state such as pid files, sockets, locks, leases, and logs must be stored under `~/.knowns`.
- FR-7: Project-owned state such as semantic indexes, code indexes, and background job queues must remain in the target project's `.knowns` directory.
- FR-8: MCP read-path tools must continue to execute synchronously against the source of truth. This includes direct getters, list operations, and non-semantic reads.
- FR-9: MCP create and update operations for tasks, docs, and memories must continue writing source-of-truth data directly before returning success.
- FR-10: After a successful source-of-truth write, MCP must enqueue follow-up indexing work to the runtime instead of performing semantic or code indexing inline.
- FR-11: Runtime-managed queue operations must include at least semantic index refresh, code index refresh, watcher-triggered file indexing, and explicit reindex jobs.
- FR-12: `knowns watch` must use the shared runtime rather than creating a separate long-lived watcher process per invocation.
- FR-13: `knowns reindex` and equivalent MCP reindex actions must enqueue work to the shared runtime rather than creating a separate indexing process.
- FR-14: The runtime must coalesce duplicate project jobs so repeated updates to the same target do not cause redundant indexing work.
- FR-15: The runtime must support debounce policies per job class so rapid sequences of updates can settle before indexing runs.
- FR-16: The runtime must process queued heavy jobs through a controlled worker pipeline that limits concurrent expensive work such as ONNX embedding.
- FR-17: The runtime must support lease or heartbeat tracking for attached clients such as MCP, CLI, and OpenCode integrations.
- FR-18: Internal runtime workers must shut down cleanly when the global runtime exits or when they lose their owning runtime lease.
- FR-19: The global runtime must be able to shut down when it is idle, has no active clients, and has no queued or running jobs.
- FR-20: The runtime must expose enough status information for `knowns` to report whether it is running, what projects are active, and whether jobs are queued or in progress.
- FR-21: Official install scripts for shell and PowerShell installs must persist install metadata under `~/.knowns` describing the install method, managed binary path, platform, architecture, channel, and update strategy.
- FR-22: `knowns update` must read the install metadata and recognize official script-based installs without relying on PATH guesses or shell history inspection.
- FR-23: When install metadata indicates an official script-managed install, `knowns update` must perform self-update using release artifacts directly rather than requiring the user to rerun the install script manually.
- FR-24: When install metadata indicates a package-manager-managed or manual install, `knowns update` must avoid unsafe self-replacement and instead return the appropriate guidance or package-manager-specific instruction.
- FR-25: After a successful self-update of a script-managed install, `knowns` must reconcile the shared runtime so future commands do not continue running against a stale runtime binary indefinitely.
- FR-26: The runtime or update flow must detect version mismatch between the current `knowns` binary and an already-running shared runtime and recover by restarting or refreshing the runtime safely.

### Non-Functional Requirements

- NFR-1: MCP request latency for source-of-truth writes must no longer include semantic or code indexing execution time.
- NFR-2: The design must avoid loading duplicate ONNX sessions for the same shared runtime execution path when a single runtime can serve the work.
- NFR-3: The runtime must preserve project isolation even though process management is centralized under `~/.knowns`.
- NFR-4: Failure of a watcher or indexing worker must not corrupt source-of-truth task/doc/memory data.
- NFR-5: Runtime logs must remain bounded and manageable under `~/.knowns/logs`.
- NFR-6: The feature must preserve backward-compatible public command UX so users continue using `knowns ...` commands rather than new public binaries.
- NFR-7: Installer metadata must be lightweight, human-inspectable, and safe to overwrite on reinstall or self-update.
- NFR-8: Self-update behavior must remain deterministic across macOS, Linux, and Windows for official script-managed installs, even if runtime restart is required after updating the binary.

## Acceptance Criteria

- [ ] AC-1: Running an MCP write operation that updates a task/doc/memory returns after the source-of-truth write completes and does not block on semantic or code indexing work.
- [ ] AC-2: After a successful MCP write, a corresponding background index job is visible to the runtime queue for the correct project.
- [ ] AC-3: Running `knowns watch` while the runtime is already active reuses the shared runtime instead of starting an additional independent watcher process.
- [ ] AC-4: Running `knowns reindex` while the runtime is already active enqueues a reindex job instead of starting a separate heavyweight indexing execution path.
- [ ] AC-5: If multiple updates target the same entity within the debounce window, the runtime executes one coalesced follow-up indexing job rather than one job per update.
- [ ] AC-6: If the runtime has no active clients, no queued jobs, and no running jobs for the configured idle period, it shuts down cleanly.
- [ ] AC-7: If the runtime is restarted, project job queues and project-owned search/index data remain intact in each project's `.knowns` directory.
- [ ] AC-8: Logs, pid files, sockets, and lease state are created under `~/.knowns` and remain separate from per-project search/index data.
- [ ] AC-9: The public UX remains `knowns ...`; users are not required to manually launch private runtime binaries.
- [ ] AC-10: The system can track attached clients such as MCP and OpenCode separately so one client disconnecting does not terminate the runtime while another active client still depends on it.
- [ ] AC-11: An official script install writes install metadata under `~/.knowns`, and `knowns update` recognizes that metadata and uses it to select the self-update flow.
- [ ] AC-12: For a script-managed install, `knowns update` can replace the managed binary without requiring the user to rerun `curl ... | sh` or `irm ... | iex` manually.
- [ ] AC-13: For a package-manager-managed or manual install, `knowns update` does not attempt unsafe self-replacement and instead reports the correct upgrade instruction.
- [ ] AC-14: After self-updating a script-managed install while the shared runtime is active, a subsequent `knowns` command does not keep using a stale runtime indefinitely and the runtime is restarted or refreshed safely.

## Scenarios

### Scenario 1: MCP write with deferred indexing
**Given** an MCP client updates a task in a project with semantic indexing enabled
**When** the write is committed to the source-of-truth store
**Then** the MCP response returns without waiting for semantic indexing to finish
**And** the runtime queue receives a project-scoped follow-up indexing job

### Scenario 2: Rapid repeated updates to the same entity
**Given** a task or doc is updated several times within a short burst
**When** the runtime applies debounce and coalescing rules
**Then** only the final follow-up indexing job for that entity is executed after the quiet window

### Scenario 3: Shared watch service
**Given** a project already has an active global runtime
**When** a user runs `knowns watch`
**Then** the command attaches to runtime-managed watch behavior instead of creating a second independent watcher process

### Scenario 4: Explicit reindex request
**Given** a project needs a semantic or code reindex
**When** the user runs `knowns reindex`
**Then** the command enqueues reindex work to the runtime
**And** the runtime processes the job through its controlled worker pipeline

### Scenario 5: Multi-client ownership
**Given** both MCP and OpenCode are attached to the same global runtime
**When** the MCP client disconnects
**Then** the runtime remains alive because OpenCode still holds an active lease
**And** the runtime only shuts down after all active clients are gone and the system becomes idle

### Scenario 6: Runtime restart
**Given** the global runtime crashes or is restarted
**When** it reconnects to project state
**Then** it can resume processing project-scoped queued work without mixing project data or losing source-of-truth writes

### Scenario 7: Script-managed self-update
**Given** Knowns was installed via the official shell or PowerShell install script
**And** the install metadata under `~/.knowns` marks the binary as script-managed
**When** the user runs `knowns update`
**Then** Knowns downloads and installs the correct release artifact directly
**And** the update flow does not require rerunning the original install script manually

### Scenario 8: Runtime after self-update
**Given** the shared runtime is already running from an older Knowns binary
**When** a script-managed self-update replaces the main binary
**Then** the next runtime-aware `knowns` command detects the version mismatch
**And** the runtime is restarted or refreshed safely before heavy work continues

### Scenario 9: Non-script install update guidance
**Given** Knowns was installed by a package manager or copied manually
**When** the user runs `knowns update`
**Then** Knowns does not attempt unsafe self-replacement
**And** it reports the correct update guidance for that installation method

## Technical Notes

- The preferred implementation model is a private/internal runtime execution path invoked by `knowns`, such as an internal subcommand, rather than a new user-facing public command.
- The global runtime should manage project-scoped workers, queues, and leases while keeping heavy resources reusable across jobs.
- Queue semantics should distinguish source-of-truth writes from derived-state refreshes. Task/doc/memory writes stay synchronous; semantic/code indexes are derived state and should be eventually consistent.
- Runtime-managed jobs should include enough metadata to identify project root, job type, target entity, dedupe key, debounce class, and retry state.
- Runtime logs should be kept under `~/.knowns/logs` and runtime sockets/pid/lease files under `~/.knowns/run` or equivalent global runtime folders.
- Watch and reindex should converge on the same runtime queue so they do not spawn redundant indexing logic or duplicate ONNX session initialization.
- This feature is expected to improve warm-command latency for `knowns` and `npx knowns` by moving heavy work out of the request path and reusing a shared runtime, but npm/npx bootstrap overhead remains outside the scope of this runtime optimization.
- Installer metadata should be stored in a stable machine-readable file such as `~/.knowns/install.json` so update logic can distinguish `script`, `manual`, and package-manager-managed installs.
- Script-managed self-update should download versioned artifacts directly and update install metadata in-place rather than reinvoking `curl ... | sh` or `irm ... | iex` from inside the binary.
- Runtime version drift should be observable, for example through runtime status metadata, so `knowns update` and later commands can safely restart stale runtime processes after replacing the main binary.

## Open Questions

- [ ] Should semantic query execution itself eventually move to the runtime, or remain directly callable from MCP while only indexing is offloaded?
- [ ] Should the global runtime use one shared IPC endpoint for all projects or a global broker that hands work to project-scoped internal workers?
- [ ] What idle timeout and lease TTL should be considered the initial default for safe auto-shutdown behavior?
