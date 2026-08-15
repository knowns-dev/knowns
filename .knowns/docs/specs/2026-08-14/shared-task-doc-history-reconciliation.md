---
title: Shared Task Doc History Reconciliation
description: Specification for daemon-managed Task/Doc filesystem reconciliation, append-only JSONL history, concurrent-session safety, retention, and incremental Qdrant synchronization.
createdAt: '2026-08-14T04:54:30.343Z'
updatedAt: '2026-08-14T05:11:09.884Z'
tags:
  - spec
  - approved
  - history
  - runtime
  - watcher
  - qdrant
---

## Overview

Knowns currently records Task and Doc revisions only when mutations pass through supported CLI, MCP, or WebUI paths. Direct Markdown edits, renames, and deletes can leave revision history and Qdrant search state inconsistent with canonical project files. Existing history JSON files also rewrite the complete history on every append and duplicate full snapshots across revisions.

This specification introduces project-local append-only JSONL revision history plus runtime-managed reconciliation for canonical Task and Doc Markdown. One shared global runtime daemon owns at most one knowledge watcher per active project, regardless of how many MCP or WebUI sessions are connected. Watch events only detect and enqueue work; reconciliation, history mutation, and Qdrant indexing remain serialized and ownership-safe through project-scoped runtime jobs.

This spec extends @doc/specs/global-runtime-queue-for-mcp-and-background-work and @doc/specs/2026-06-26/doc-history-revision-log-and-webui. Canonical Task and Doc Markdown remains the source of current truth. JSONL is the authoritative revision log. Qdrant remains a rebuildable semantic index.

## Locked Decisions

- D1: A project knowledge watcher runs only while at least one eligible client holds a watch-enabled runtime lease. After the final eligible client disconnects, the watcher stops after a configurable grace period whose default is 30 seconds.
- D2: Filesystem events are debounced for 3 seconds and coalesced by stable entity identity. Continuous edit activity must flush a coalesced revision at least every 30 seconds; checkpoint-versus-delta selection follows D4.
- D3: New Task and Doc history uses project-local JSONL, one append-only log per stable entity, under `.knowns/history/`. History is not stored under `~/.knowns`, and the project-local history directory remains Git-ignored by default.
- D4: Normal revisions store only the changed fields, section replacement, or text patch. Full snapshots are stored only for the initial state, explicit or policy-selected checkpoints, retention compaction, or when a delta would be inefficient or unsafe.
- D5: Legacy JSON migration is dual-read and single-write. Existing revisions are preserved as legacy JSONL records rather than optimistically rewritten. A verified current checkpoint is appended when the legacy root is incomplete or its hash chain is missing or inconsistent. Legacy JSON remains untouched until an explicit cleanup operation.
- D6: Bulk changes such as Git checkout, pull, sync, or import still produce one final revision per affected entity. Revisions share a batch ID and source, and Qdrant work is coalesced into bounded batch jobs.
- D7: Concurrent writes use optimistic concurrency. A mutation whose expected canonical hash is stale fails with a conflict and must be reread or merged; Knowns never silently overwrites the newer state.
- D8: Default retention keeps at most 200 detailed revisions and at most 90 days of detailed history. Compaction must preserve the checkpoint required to restore every retained revision, the current revision, and explicit retention-gap metadata.
- D9: Direct filesystem rename and delete are tracked. Stable IDs preserve history across rename. Delete creates a restorable tombstone revision and removes the entity from Qdrant. Only an explicit, authorized Hard Delete purges canonical data, history, and unreferenced history payloads.

## System Decision Impact

- Impact: none
- Decision: This spec applies the already approved global-runtime and Doc-history architecture. D1-D9 are scoped Spec Decisions for this feature; no current accepted System Decision matched the proposed change.
- Acceptance gate: not applicable

## Requirements

### Functional Requirements

- FR-1: MCP and other eligible long-lived clients must acquire a watch-enabled global runtime lease when automatic Task/Doc reconciliation is enabled for the project.
- FR-2: The global runtime must create at most one Task/Doc knowledge watcher per project even when multiple eligible clients hold independent leases.
- FR-3: Watcher activation, heartbeat expiry, explicit lease release, and watcher shutdown must follow D1 without terminating the global runtime while other clients or queued jobs remain active.
- FR-4: The watcher must observe only canonical Task and Doc Markdown roots and must ignore history files, Qdrant/search state, temporary files, lock files, and Knowns runtime state.
- FR-5: Watch events must be treated as hints. Reconciliation must wait for a stable readable file, parse the canonical entity, resolve its stable identity, and compare canonical content hashes before creating history or indexing work.
- FR-6: The system must suppress duplicate events caused by Knowns' own atomic writes and must not create a second revision when the canonical hash already equals the history head.
- FR-7: Task identity must continue to use the Task ID in canonical frontmatter. Doc canonical frontmatter must carry a stable Doc ID so a direct filesystem rename can retain the same history.
- FR-8: Duplicate stable IDs, identity/path ambiguity, malformed frontmatter, or partial editor writes must fail closed: no history append, Qdrant mutation, or implicit identity reassignment may occur until reconciliation can resolve the entity safely.
- FR-9: A filesystem reconciliation revision must include schema version, entity type and stable ID, monotonically increasing revision number, timestamp, actor when known, source, optional session and batch IDs, base hash, new hash, change scopes, and either delta or checkpoint payload.
- FR-10: Task deltas must contain only changed fields. Doc deltas must prefer section replacement when a section is unambiguous and otherwise use a deterministic whole-document patch. A full checkpoint must be selected when a delta cannot be applied deterministically or exceeds the configured efficiency threshold.
- FR-11: JSONL appends must be serialized per entity across processes and sessions. A successful append must become durable before its revision is reported as committed.
- FR-12: History readers must support metadata pagination and lazy revision-detail loading without reading or returning every checkpoint or content payload by default.
- FR-13: History restore and diff must work across legacy records, checkpoints, deltas, retention gaps, filesystem revisions, rename revisions, and delete tombstones.
- FR-14: Direct filesystem edits made while no watcher is active must be discovered by a startup or explicit reconciliation pass using a persisted lightweight file-state manifest and canonical hashes.
- FR-15: The system must expose an explicit project reconciliation command with a dry-run/preview mode and a wait mode. Preview must report affected entities without mutating history or Qdrant.
- FR-16: Bulk reconciliation must follow D6, apply queue backpressure, and avoid enqueuing one independent embedding job per raw filesystem event.
- FR-17: Every supported Task/Doc mutation surface must enforce D7 using the latest canonical hash. Conflict responses must identify the affected entity and expected-versus-current hash without exposing content.
- FR-18: JSONL readers must tolerate and report a truncated final line without accepting it as a revision. Corruption before the final line, a sequence discontinuity, or a hash-chain mismatch must fail closed and provide an actionable repair path.
- FR-19: Retention compaction must follow D8, write a replacement log through a temporary file, validate retained restore paths and hash continuity, durably sync it, and atomically replace the active log.
- FR-20: Legacy JSON must remain readable until migrated. First post-upgrade history write or an explicit migration command must perform D5 under an entity migration lock, validate the resulting JSONL, and leave legacy JSON authoritative if migration fails.
- FR-21: Successful migration must not delete or modify legacy JSON. An explicit, separately confirmed cleanup command may remove verified legacy files that have an authoritative JSONL successor.
- FR-22: Direct filesystem rename must preserve the entity ID, append a rename revision, update the Doc path index or Task location, rewrite supported references through existing safe mechanisms when applicable, and update Qdrant without creating a second entity.
- FR-23: Direct filesystem delete must append a tombstone revision using the last verified history state, remove the entity from active search, and retain enough information for an authorized restore.
- FR-24: Hard Delete must remain distinct from filesystem delete. It must require existing authorization and confirmation rules and must purge the entity history plus any unreferenced history payloads.
- FR-25: History commit must not depend on Qdrant availability. After history is durable, Qdrant work must be queued and retried; readiness surfaces must report stale indexing until the canonical entity hash is indexed.
- FR-26: Qdrant reconciliation must index only affected entities or chunks for normal edits and must use bounded batch upserts for D6. It must not rebuild or swap the active collection for routine filesystem reconciliation.
- FR-27: Project histories, locks, manifests, jobs, and watcher state must remain isolated by canonical project root and stable entity identity.
- FR-28: Existing Task lifecycle behavior, Doc revision metadata, section restore, retention-gap reporting, and audit/session fields must be preserved or mapped without loss in the JSONL reader/writer.
- FR-29: The default implementation must not introduce SQLite as a history dependency. A future backend migration requires separate benchmark evidence and specification.

### Non-Functional Requirements

- NFR-1: An idle watcher must perform no periodic full-content hashing and must add negligible CPU load; unchanged files should be skipped using persisted file metadata before hash verification.
- NFR-2: Filesystem reconciliation and Qdrant embedding must remain asynchronous to MCP request transport and must not make ordinary MCP reads wait for watcher work.
- NFR-3: Ten or more sessions attached to the same project must not create duplicate project watchers or duplicate revisions for one canonical hash.
- NFR-4: History writes, migration, and compaction must be crash-consistent through per-entity locking, temporary staging, file and directory synchronization, validation, and atomic activation.
- NFR-5: Queue growth must be bounded through entity/hash deduplication, event coalescing, batch jobs, retry limits, and observable failure state.
- NFR-6: Behavior must be covered on macOS, Linux, and Windows, including editor temp-file rename patterns and platform-specific filesystem event sequences.
- NFR-7: History remains security-sensitive project data. Logs, status, conflicts, and diagnostics must never expose revision content, secrets, signed URLs, credentials, or unredacted external endpoints.
- NFR-8: Direct deletion does not constitute privacy purge. User-facing output must explain that prior content remains in history until authorized Hard Delete or explicit history purge.
- NFR-9: JSONL schema changes must be versioned, backward-readable, and validated before new writers activate a migrated log.

## Acceptance Criteria

- [ ] AC-1: Given ten active MCP sessions for one project, runtime status shows ten valid client leases and exactly one knowledge watcher for that project.
- [ ] AC-2: When nine of ten sessions disconnect, the watcher remains active; when the final session disconnects, it stops only after the configured 30-second default grace period while unrelated runtime work remains unaffected.
- [ ] AC-3: A valid direct Task or Doc Markdown edit produces exactly one filesystem-source revision after the 3-second quiet window and queues incremental Qdrant indexing for the resulting canonical hash.
- [ ] AC-4: Fifty editor events for the same canonical hash inside one debounce window produce no more than one revision and one effective indexing job.
- [ ] AC-5: Continuous edits are flushed as a coalesced revision within the 30-second maximum window under a deterministic fake-clock test.
- [ ] AC-6: A Knowns-originated atomic Markdown write does not create a duplicate filesystem revision when the watcher observes its temp/write/rename events.
- [ ] AC-7: An edit performed while no watcher is active is detected by the next startup or explicit reconciliation pass and becomes one revision before its canonical hash is reported as indexed.
- [ ] AC-8: Two sessions updating the same entity from the same base hash result in one successful write and one observable conflict; no canonical field, revision, or Qdrant state is silently overwritten.
- [ ] AC-9: Direct rename preserves the stable entity ID and history sequence, updates search to the new path, and leaves no duplicate entity at the old path.
- [ ] AC-10: Direct delete creates a tombstone, removes active search results, and can be restored; authorized Hard Delete removes the canonical entity, JSONL history, verified legacy history, and unreferenced history payloads.
- [ ] AC-11: Duplicate IDs, malformed Markdown, an incomplete editor write, or an ambiguous rename produces no history or indexing mutation and surfaces an actionable diagnostic.
- [ ] AC-12: A bulk Git/import fixture affecting hundreds of entities assigns one batch ID, creates at most one final revision per changed entity, and submits bounded Qdrant batch work without unbounded queue growth.
- [ ] AC-13: A Task field update and Doc section update append delta-only JSONL records; their records do not repeat the complete unchanged entity snapshot.
- [ ] AC-14: Initial history, policy-selected checkpoints, oversized or unsafe deltas, and retention compaction create full checkpoints that can independently seed replay.
- [ ] AC-15: Every retained revision can be reconstructed and hash-verified from its nearest preceding checkpoint plus deltas.
- [ ] AC-16: Default retention never leaves more than 200 detailed revisions older than the protected current/checkpoint set, removes detail older than 90 days, and emits accurate retention-gap metadata.
- [ ] AC-17: A legacy Task history with complete snapshots migrates without changing revision numbers, timestamps, actor/session metadata, or reconstructable states.
- [ ] AC-18: A legacy Doc history with an incomplete root or mismatched adjacent hashes is preserved as legacy records and followed by a verified migration-reconcile checkpoint; migration never invents missing historical content.
- [ ] AC-19: Failed or interrupted migration leaves the original JSON readable and authoritative, leaves no active partial JSONL, and allows a safe retry.
- [ ] AC-20: After successful migration, the original JSON remains unchanged until an explicitly confirmed cleanup removes only files with verified authoritative JSONL successors.
- [ ] AC-21: A truncated final JSONL line is ignored and reported without losing earlier valid revisions; corruption before the tail or a broken sequence/hash chain fails closed.
- [ ] AC-22: Injected append, fsync, validation, compaction, and atomic-swap failures preserve the previously durable history head and canonical legacy fallback.
- [ ] AC-23: When Qdrant is unavailable, history and canonical file changes remain durable, indexing jobs remain retryable, and readiness reports the stale canonical hash without leaking content.
- [ ] AC-24: Normal reconciliation updates only the changed entity/chunks and does not perform a full Qdrant generation rebuild.
- [ ] AC-25: History list APIs and UI routes can page revision metadata without loading full delta/checkpoint payloads, while explicit diff/restore retrieves only required records.
- [ ] AC-26: Cross-project tests prove that identical Task/Doc IDs, paths, hashes, and concurrent watcher activity cannot mix histories, locks, jobs, or Qdrant ownership.
- [ ] AC-27: Existing Task/Doc history commands, MCP actions, WebUI history/diff/restore behavior, lifecycle archive/reopen, and retention-gap rendering remain backward compatible through the new history abstraction.
- [ ] AC-28: Full repository tests, race-focused concurrency tests, crash-injection tests, cross-platform watcher tests, Go vet/build, diff checks, and strict Knowns validation pass.

## Scenarios

### Scenario 1: One MCP session activates reconciliation
**Given** a project has no active knowledge watcher
**When** an MCP server acquires a watch-enabled lease
**Then** the global runtime creates one project watcher and performs lightweight startup reconciliation
**And** ordinary MCP reads remain available while reconciliation runs

### Scenario 2: Ten sessions share one watcher
**Given** ten MCP sessions use the same project
**When** all sessions hold independent runtime leases
**Then** runtime maintains one watcher for that project
**And** the watcher remains active until the final eligible lease ends plus the configured grace period

### Scenario 3: Editor autosave changes a Doc
**Given** a Doc has a verified history head
**When** an editor emits repeated temp/write/rename events while changing one section
**Then** runtime waits for a stable file, resolves the stable Doc ID, and appends one section delta
**And** it queues one effective incremental Qdrant update

### Scenario 4: Knowns observes its own write
**Given** MCP updates a Task through a supported mutation path
**When** the atomic Markdown write also produces filesystem events
**Then** canonical-hash deduplication suppresses a second filesystem revision and indexing job

### Scenario 5: Concurrent same-entity update
**Given** two sessions read the same base hash
**When** the first commits and the second submits its stale expected hash
**Then** the second receives a conflict and no automatic overwrite or merge occurs

### Scenario 6: Offline manual edit
**Given** no eligible client or watcher is active
**When** a user edits a canonical Markdown file
**Then** the next startup or explicit reconciliation compares persisted file state and canonical hashes
**And** records the missed change before claiming the entity is indexed

### Scenario 7: Bulk Git checkout
**Given** a checkout changes hundreds of Task and Doc files
**When** the watcher receives a burst of filesystem events
**Then** reconciliation creates at most one final revision per changed entity under one batch ID
**And** Qdrant work is coalesced and bounded

### Scenario 8: Direct rename and delete
**Given** canonical frontmatter contains a stable entity ID
**When** a file is renamed directly
**Then** history continues under the same ID and search moves to the new path
**When** the file is later deleted directly
**Then** a restorable tombstone is appended and active search removes the entity

### Scenario 9: Legacy history with a chain mismatch
**Given** a legacy Doc JSON has adjacent revisions whose hashes do not connect
**When** migration runs
**Then** original records are preserved as legacy JSONL records
**And** a verified checkpoint of the current canonical Doc begins a trustworthy new chain
**And** no missing historical state is inferred

### Scenario 10: Interrupted migration
**Given** a valid legacy JSON is authoritative
**When** JSONL staging, sync, validation, or activation fails
**Then** the legacy file remains unchanged and readable
**And** no partial JSONL becomes authoritative

### Scenario 11: Qdrant unavailable
**Given** canonical and history storage are healthy but Qdrant is stopped
**When** a filesystem reconciliation commits
**Then** the canonical change and history remain durable
**And** runtime retains retryable indexing work and exposes stale readiness

### Scenario 12: Retention and restore
**Given** an entity exceeds default age or count retention
**When** compaction runs
**Then** old detail is replaced by an explicit retention gap and safe checkpoint
**And** every retained revision remains reconstructable and hash-valid

## Technical Notes

- Reuse the existing global runtime lease and watcher reconciliation model in `internal/runtimequeue`. MCP currently acquires a runtime lease with watch disabled; this feature should make watch demand project-configurable and observable.
- Replace the current code-only watcher entry point with or add a narrowly scoped knowledge watcher for canonical Task/Doc directories. Do not recursively watch `.knowns/history`, search state, runtime state, or temporary staging paths.
- Introduce a backend-neutral history interface so legacy JSON and JSONL can coexist during migration while CLI, MCP, server, and lifecycle callers retain one API.
- Suggested layout:
  - `.knowns/history/tasks/<task-id>.jsonl`
  - `.knowns/history/docs/<doc-id>.jsonl`
  - `.knowns/history/doc-path-index.json`
  - `.knowns/history/state/manifest.json`
  - `.knowns/history/locks/`
- JSONL should include an explicit schema/version record or versioned fields and one immutable revision record per line. Retention compaction is the only normal operation that rewrites an active JSONL log.
- Use per-entity cross-process locks and expected-hash comparison. Watchers never mutate history directly; they enqueue reconciliation work.
- The current runtime executor processes background jobs serially. D6 batching and deduplication are required in this scope; increasing worker concurrency is optional only after correctness and queue-pressure benchmarks.
- Preserve existing stable Doc history identity and add the Doc ID to canonical frontmatter. Duplicate IDs created by copying files must fail closed and receive explicit repair guidance.
- Existing legacy JSON remains security-sensitive and is not automatically deleted. Cleanup must be explicit, previewable, verified, and separately confirmed.
- Qdrant pointer/generation state is not part of history storage. Routine reconciliation targets the active owned collection and relies on canonical-hash payload validation already used by semantic search.
- No internet or external service is required for history append, replay, migration, retention, or restore.

- @task-nheh4b [shared-task-doc-history-reconciliation-01] Build JSONL history storage and replay — todo
- @task-j5bnhh [shared-task-doc-history-reconciliation-02] Migrate legacy history and implement durable retention — todo
- @task-bfkpm3 [shared-task-doc-history-reconciliation-03] Add stable identity and optimistic concurrency — todo
- @task-xeyfec [shared-task-doc-history-reconciliation-04] Add runtime watch-lease lifecycle — todo
- @task-y48jfu [shared-task-doc-history-reconciliation-05] Reconcile filesystem Task and Doc changes — todo
- @task-pkrwls [shared-task-doc-history-reconciliation-06] Handle bulk rename tombstone restore and purge — todo
- @task-bi2dp3 [shared-task-doc-history-reconciliation-07] Queue targeted Qdrant reconciliation — todo
- @task-zs8dt4 [shared-task-doc-history-reconciliation-08] Complete public history compatibility and verification — todo

## Open Questions

- None.
