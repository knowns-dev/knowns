---
title: Qdrant Default Vector Backend
description: Specification for making managed Qdrant the default semantic vector backend for new Knowns installs while preserving graceful fallback and rebuild migration from SQLite.
createdAt: '2026-08-13T07:25:31.700Z'
updatedAt: '2026-08-13T13:53:30.900Z'
tags:
  - draft
  - review-required
---

# Qdrant Default Vector Backend

## Overview

Knowns currently stores semantic vector index data in a project-local SQLite database at `.knowns/.search/index.db`. That SQLite index is derived data built from canonical Knowns sources such as docs, tasks, memories, and decisions. The existing SQLite vector store also performs brute-force similarity search in process after loading vectors.

This spec makes Qdrant the default semantic vector backend for new Knowns installs. Knowns will manage a local Qdrant runtime under `~/.knowns/runtime/qdrant` by default, store project isolation metadata in project `.knowns`, and migrate existing SQLite vector indexes by rebuilding from canonical sources.

Supporting placement pattern: @doc/architecture/patterns/qdrant-vector-store-placement-pattern

## Locked Decisions

- D1: This spec focuses only on Qdrant as the default vector backend. History optimization and general directory taxonomy cleanup are out of scope.
- D2: Qdrant provisioning uses hybrid mode. The default is a managed local Qdrant binary under `~/.knowns/runtime/qdrant`; an external Qdrant URL/config/env override is supported for advanced users. Docker is not the default path.
- D3: When Qdrant or embeddings are not ready, Knowns uses async graceful degradation: keyword and retrieve fallback still work, semantic readiness is reported as degraded, setup and reindex are queued in the background, and blocking only happens for explicit commands such as `knowns search index --wait`, `knowns qdrant install`, or explicit Qdrant runtime commands.
- D4: Existing SQLite semantic indexes are migrated by rebuild, not by row migration. On first semantic use after upgrade, Knowns creates a Qdrant collection UUID, reindexes canonical sources into Qdrant, swaps semantic metadata to Qdrant, and treats SQLite only as temporary legacy fallback during the migration window.
- D5: Qdrant payloads are pointer-only by default. Qdrant stores vectors plus metadata, filters, hashes, offsets, and source IDs, but does not store full raw chunk text in v1. Search accuracy comes from vector similarity plus BM25 or keyword hybrid search. Snippets and context are read from canonical Knowns files with hash and version checks.
- D6: Collection isolation is per Knowns store. Each project store has one active Qdrant collection UUID. The global store or global memory store has separate collection UUIDs. Source types are separated by payload filters, not separate collections. Reindex, model, or chunk-version changes create a next-generation collection and atomically swap the pointer after success.
- D7: After a successful Qdrant generation swap, Knowns keeps at most the most recent inactive collection for rollback. The default rollback TTL is 72 hours and the maximum inactive generation count is 1 per store. The count limit is a hard cap: after each successful generation swap, inactive generations beyond the most recent previous generation are eligible for immediate cleanup even if they are younger than the TTL. The most recent inactive generation is retained until its TTL expires, then cleaned. Explicit privacy or hard purge operations bypass rollback retention and delete immediately.
- D8: Spec v1 preserves the approved read-only doctor contract from @doc/specs/2026-07-25/knowns-doctor. `knowns doctor` reports Qdrant semantic readiness and emits exact remediation commands, but does not install, start, stop, reindex, write pointers, or delete collections. Mutating repair remains explicit through `knowns search index --wait` and `knowns qdrant status/start/stop/logs/cleanup/install`; future automatic repair requires a separately versioned doctor contract.
- D9: Qdrant and semantic vector search have explicit opt-out. Users can disable semantic vector search globally or per project via config/env. Disabled mode runs keyword-only without starting Qdrant, creating collections, or queuing semantic reindex. Existing Qdrant pointers remain dormant unless explicitly purged.
- D10: Managed Qdrant uses lazy installation by default. `knowns init` configures Qdrant as the default semantic backend, but the binary is installed and started only on first semantic use or explicit index/runtime commands. First semantic use remains non-blocking through keyword fallback plus background bootstrap. `knowns qdrant install` is an explicit blocking command. Managed install must use a pinned Knowns-supported Qdrant version, platform/architecture mapping, HTTPS download from an approved source or configured mirror, checksum verification before execution, atomic staging and rename, failure cleanup, and actionable offline/proxy diagnostics.

## System Decision Impact

- Impact: draft new
- Decision: Draft a System Decision during implementation for adopting managed Qdrant as the default semantic vector backend and deprecating SQLite as the default vector backend.
- Acceptance gate: The System Decision can become accepted only after the spec is approved, Qdrant readiness and migration behavior are implemented, and validation confirms keyword fallback, Qdrant indexing, and SQLite rebuild migration work.

## Requirements

### Functional Requirements

- FR-1: New Knowns installs must default semantic vector search to Qdrant when semantic search is enabled.
- FR-2: Knowns must support a managed local Qdrant runtime rooted at `~/.knowns/runtime/qdrant`.
- FR-3: Knowns must support an advanced external Qdrant URL/config/env override.
- FR-4: Project stores must keep only lightweight Qdrant pointer metadata in project `.knowns`, not vector data or embedding values.
- FR-5: Each project store must own an isolated active Qdrant collection UUID.
- FR-6: The global store or global memory semantic store must use collection UUIDs separate from project stores.
- FR-7: Qdrant collection names must be derived from generated collection UUIDs rather than project paths.
- FR-8: Qdrant payloads must include enough pointer metadata to resolve search hits back to canonical Knowns sources.
- FR-9: Qdrant payloads must not store full raw chunk text by default in v1.
- FR-10: Search and retrieve must continue to work with keyword or BM25 fallback when Qdrant, embeddings, or semantic index readiness is degraded.
- FR-11: First semantic use must be able to queue Qdrant install/start/reindex work asynchronously without blocking normal search results.
- FR-12: Explicit blocking commands must exist for users who want deterministic setup or indexing completion.
- FR-13: Existing SQLite vector indexes must migrate by rebuilding canonical sources into Qdrant, not by copying SQLite rows.
- FR-14: SQLite must remain available only as temporary legacy fallback during the migration window.
- FR-15: Reindex must build into a next-generation Qdrant collection and atomically swap the project pointer after successful validation.
- FR-16: Old Qdrant collection generations must be retained briefly for rollback and cleaned automatically according to the retention precedence in D7.
- FR-17: `knowns doctor` must report Qdrant runtime, collection, pointer, model, dimensions, chunk version, and orphan collection readiness without mutating local or external state.
- FR-18: Every Qdrant doctor warning/failure must include exact remediation through existing explicit commands such as `knowns qdrant install`, `knowns qdrant start`, `knowns search index --wait`, `knowns qdrant cleanup`, or a manual external-Qdrant action.
- FR-19: `knowns qdrant status/start/stop/logs/cleanup/install` must provide runtime-specific inspection and operations. `install`, `start`, and process cleanup apply only to managed mode. External mode must bypass local process ownership.
- FR-20: Users must be able to disable semantic vector search globally or per project.
- FR-21: Managed Qdrant installation must verify provenance before execution: supported OS/architecture, pinned version, approved HTTPS or configured mirror source, checksum verification, atomic staging/rename, partial-install cleanup, and actionable offline/proxy/mirror failure messages.
- FR-22: External Qdrant configuration must support authenticated and TLS-secured endpoints in v1. Non-loopback external endpoints must use HTTPS. Plain HTTP is allowed only for loopback addresses. API keys must come from environment or configured secret sources, must be sent using Qdrant's `api-key` header, and must never be written to project pointer metadata, doctor/readiness evidence, status output, or logs.
- FR-23: Ordinary Qdrant collection cleanup must require positive ownership proof. A collection is safe to delete only when it is referenced by this store's active pointer/generation history or by a Knowns-owned managed-runtime registry entry for the same owner fingerprint and store root. Collection names or missing project pointers alone are not sufficient ownership proof.
- FR-24: External Qdrant cleanup must be conservative in v1. Doctor/readiness may report orphan candidates, but automatic or background deletion is disabled for external endpoints unless the current store's own pointer/generation metadata proves ownership and the user runs an explicit destructive command.

### Non-Functional Requirements

- NFR-1: Qdrant derived vector data must not be committed to project repositories by default.
- NFR-2: Project paths must not be used as primary Qdrant collection identifiers.
- NFR-3: Qdrant bootstrap must not make ordinary first search usage feel broken or hang for a long time.
- NFR-4: Failure states must be explicit and actionable through readiness output, doctor checks, and logs.
- NFR-5: Project and global semantic collections must remain isolated to prevent accidental cross-store leakage.
- NFR-6: Search results must avoid stale snippets by validating content hash, chunk version, model, dimensions, and source existence before using canonical content.
- NFR-7: Runtime cleanup must prevent unbounded accumulation of old collections, stale process state, and orphaned generations while never deleting collections without the ownership proof required by FR-23.
- NFR-8: Opt-out mode must be quiet and intentional. If semantic search is disabled, doctor must not treat the absence of Qdrant as a failure.
- NFR-9: The implementation must preserve existing keyword search behavior during Qdrant outages or migration.
- NFR-10: The Qdrant integration must expose enough logs and status for debugging without requiring users to inspect raw Qdrant internals.
- NFR-11: Secrets, API keys, signed URLs, and authorization headers must be redacted from all project metadata, doctor/readiness evidence, status output, and logs.
- NFR-12: Mutating commands that delete collections or purge semantic state must be explicit and must fail closed when ownership proof is missing or ambiguous.

- [ ] AC-1: A new project with semantic search enabled reports Qdrant as the default vector backend in config/readiness without requiring manual Qdrant setup.
- [ ] AC-2: Managed Qdrant runtime files, data, logs, pid/status metadata, install staging, verified binaries, and managed process state are stored under `~/.knowns/runtime/qdrant`.
- [ ] AC-3: Project `.knowns/.search/qdrant.json` is created with collection UUID, collection name, schema version, chunk version, embedding provider/model/dimensions, owner fingerprint, timestamps, and chunk count metadata.
- [ ] AC-4: Project `.knowns` does not store Qdrant vector data, embedding values, external API keys, signed URLs, or authorization headers.
- [ ] AC-5: First semantic use on a machine without installed managed Qdrant returns keyword fallback results promptly and queues managed Qdrant bootstrap/reindex in the background.
- [ ] AC-6: `knowns search index --wait` blocks until managed Qdrant setup and reindex either succeed or fail with actionable diagnostics.
- [ ] AC-7: `knowns doctor` reports semantic readiness across Qdrant binary/install state, process health, collection existence, model, dimensions, chunk version, pointer validity, external mode security posture, and safe orphan candidates without mutating files, processes, pointers, or collections.
- [ ] AC-8: For every Qdrant readiness warning or failure, `knowns doctor` prints an exact safe remediation command or manual external-Qdrant action, and tests prove no `doctor` flag combination installs, starts, reindexes, writes pointers, or deletes collections.
- [ ] AC-9: `knowns qdrant status/start/stop/logs/cleanup/install` exists and performs the expected runtime-specific operations; managed install verifies checksum/provenance and external mode bypasses local process ownership.
- [ ] AC-10: Existing projects with `.knowns/.search/index.db` create a Qdrant collection and reindex canonical sources on first semantic use after upgrade rather than migrating SQLite rows.
- [ ] AC-11: During migration failure or Qdrant outage, keyword search remains usable and semantic readiness is reported as degraded rather than corrupting the active store.
- [ ] AC-12: Reindex creates a next-generation collection, validates collection config, model, dimensions, chunk version, owner metadata, payload metadata, and point/chunk count, then atomically swaps the project pointer and leaves the prior active collection available for rollback only after validation succeeds.
- [ ] AC-13: Old inactive collections follow D7 retention precedence: keep at most the most recent inactive generation, delete older excess inactive generations immediately after successful cleanup, and delete the retained inactive generation after the 72h TTL expires.
- [ ] AC-14: Explicit privacy or hard purge commands bypass rollback retention and remove only positively owned relevant Qdrant collections immediately, failing closed when ownership proof is missing.
- [ ] AC-15: Qdrant payloads do not contain full raw chunk text by default, but include source IDs, chunk IDs, offsets, content hashes, source type, and filter metadata.
- [ ] AC-16: Search/retrieve resolves snippets and context from canonical Knowns files and drops or degrades stale results when hashes, versions, dimensions, model identity, or source existence do not match.
- [ ] AC-17: Project store and global store searches use separate Qdrant collection UUIDs and merge results at the Knowns search/retrieve layer.
- [ ] AC-18: Disabling semantic search globally or per project prevents Qdrant auto-start, collection creation, and semantic reindex queueing while preserving keyword-only behavior.
- [ ] AC-19: External Qdrant URL override works without managed local process ownership, enforces the loopback-HTTP/non-loopback-HTTPS policy, supports API-key authentication from non-persisted secret sources, and redacts secrets in readiness/doctor/status output.
- [ ] AC-20: SQLite is no longer the default vector backend for new installs once this spec is implemented.
- [ ] AC-21: Managed Qdrant install tests cover pinned version and supported OS/arch selection, checksum verification failure, atomic staging/rename, partial-install cleanup, upgrade compatibility that preserves the previous working binary, and actionable offline/proxy/mirror diagnostics.
- [ ] AC-22: Ordinary Qdrant collection cleanup deletes only collections with positive ownership proof from this store's pointer/generation metadata or the managed ownership registry; collection-name shape or a missing project pointer alone is insufficient, and unowned external candidates are reported but never deleted.
- [ ] AC-23: Production Qdrant runtime search/retrieve uses QueryValidated so stale hits are dropped or degraded before snippets/context are assembled, and tests cover the wired production path.

## Scenarios

### Scenario 1: New install first search

**Given** a user has installed Knowns and initialized a project with default config
**And** managed Qdrant has not been downloaded or started yet
**When** the user runs `knowns search "auth"`
**Then** Knowns returns keyword or BM25 fallback results promptly
**And** the output or readiness metadata reports semantic search as warming or degraded
**And** Knowns queues managed Qdrant install/start/reindex work in the background
**And** no Qdrant vector data is written to project `.knowns`.

### Scenario 2: Explicit blocking index

**Given** semantic search is enabled for a project
**When** the user runs `knowns search index --wait`
**Then** Knowns installs or starts managed Qdrant if needed
**And** creates or validates the project Qdrant pointer
**And** indexes canonical project sources into the active Qdrant collection
**And** exits successfully only after the semantic index is ready, or fails with actionable diagnostics.

### Scenario 3: Existing SQLite project after upgrade

**Given** a project has an existing `.knowns/.search/index.db`
**And** no active Qdrant pointer exists
**When** semantic search is first used after upgrading
**Then** Knowns creates a new Qdrant collection UUID
**And** rebuilds semantic chunks from canonical project sources
**And** writes `.knowns/.search/qdrant.json`
**And** does not copy SQLite rows into Qdrant
**And** keyword fallback remains available if rebuild fails.

### Scenario 4: Reindex after chunk version change

**Given** a project has an active Qdrant collection
**And** the chunk version or embedding identity has changed
**When** a reindex runs
**Then** Knowns creates a next-generation collection
**And** indexes all canonical chunks into that new collection
**And** validates chunk count, model, dimensions, owner metadata, payload metadata, and collection configuration
**And** atomically swaps the pointer only after success
**And** keeps only the most recent prior collection for rollback within the retention window.

### Scenario 5: Semantic opt-out

**Given** a user disables semantic vector search in global or project config
**When** the user runs `knowns search` or `knowns retrieve`
**Then** Knowns runs keyword-only behavior
**And** does not start Qdrant
**And** does not create collections
**And** does not queue semantic reindex
**And** doctor reports semantic search as disabled rather than failed.

### Scenario 6: External Qdrant override

**Given** a user configures an external Qdrant URL
**And** the endpoint is loopback HTTP or non-loopback HTTPS
**And** any API key is supplied through environment or another non-persisted secret source
**When** semantic search or indexing needs Qdrant
**Then** Knowns connects to the external Qdrant endpoint using the configured API key header when present
**And** does not manage local Qdrant process lifecycle
**And** still uses per-store collection UUIDs and pointer metadata
**And** doctor reports external mode health and security posture without exposing secrets.

### Scenario 7: Stale pointer result

**Given** Qdrant returns a chunk whose content hash or chunk version no longer matches canonical source files
**When** Knowns assembles search snippets or retrieve context
**Then** Knowns skips or degrades that result
**And** reports the semantic index as stale
**And** queues or recommends reindex.

### Scenario 8: Orphan collection cleanup

**Given** Qdrant contains inactive or orphan candidate collections
**When** background maintenance or `knowns qdrant cleanup` runs
**Then** Knowns deletes only collections with positive ownership proof
**And** applies D7 retention precedence
**And** preserves the currently active and allowed previous generation collections
**And** reports unowned or ambiguous external candidates without deleting them.

### Scenario 9: Managed binary install verification

**Given** managed Qdrant is not installed
**When** the user runs `knowns qdrant install` or a blocking managed setup path requires the binary
**Then** Knowns selects a supported OS/architecture artifact and pinned version
**And** downloads from an approved HTTPS source or configured mirror
**And** verifies the artifact checksum before execution
**And** stages the binary atomically under the managed runtime root
**And** removes partial installs and prints actionable diagnostics when verification, network, proxy, mirror, or platform checks fail.

## Technical Notes

### Current architecture touchpoints

Current SQLite/vector behavior is concentrated around these areas:

- `internal/search/vecstore.go`
- `internal/search/sqlite_vecstore.go`
- `internal/search/init.go`
- `internal/search/semantic_runtime.go`
- `internal/search/runtime_search.go`
- `internal/readiness/readiness.go`
- `internal/cli/search.go`
- `internal/cli/code.go`
- `internal/server/routes/graph.go`

The current `VectorStore` interface includes load/save/clear/add/remove/search/count/stats/model/content-hash operations. Qdrant integration should either implement this interface with backend-neutral behavior or introduce a backend-neutral semantic index abstraction where Qdrant does not need fake local load/save semantics.

### Backend-neutral readiness

Direct SQLite metadata checks should be refactored behind a backend-neutral readiness interface. In particular, code paths that directly inspect `.knowns/.search/index.db` should instead ask the configured semantic backend for readiness, stats, model identity, dimensions, migration state, and whether repair is an explicit command rather than a doctor mutation.

### Managed install contract

`knowns qdrant install` is the explicit blocking install command for managed mode. Lazy first-use bootstrap may call the same installer asynchronously, and `knowns search index --wait` may call it synchronously before reindexing.

The installer contract is:

- Source metadata is pinned by the Knowns release or embedded manifest: Qdrant version, supported OS/architecture tuples, artifact URL template or mirror override semantics, and expected SHA-256 checksum per artifact.
- Downloads use HTTPS unless a user explicitly configures a trusted local file mirror path. Redirects must not cross to an unapproved host unless the mirror configuration allows it.
- The downloaded artifact is verified before extraction or execution. Checksum mismatch, unsupported platform, network failure, proxy failure, and mirror failure all fail closed with diagnostics.
- Installation stages into a temporary directory under `~/.knowns/runtime/qdrant`, fsyncs/renames into the active binary path atomically where supported, and cleans partial files on failure.
- Existing installed binaries are reused when the version and checksum match. Upgrades use the same stage-and-rename path and preserve the previous working binary until the replacement verifies.
- Doctor may report install problems and exact install commands, but does not run the installer in v1.

### External Qdrant security contract

External Qdrant is for advanced users and must fail closed when configured insecurely outside loopback:

- Plain HTTP is allowed only for loopback hosts such as `localhost`, `127.0.0.1`, or `::1`.
- Non-loopback external URLs must use HTTPS with normal certificate verification.
- API keys are supplied through environment or non-persisted secret configuration and sent with Qdrant's `api-key` header.
- API keys, authorization headers, signed URLs, and embedded credentials must not be persisted in `qdrant.json`, `qdrant-generations.jsonl`, doctor evidence, readiness metadata, qdrant status output, or logs.
- Readiness and doctor output may show sanitized endpoint metadata such as mode, scheme, loopback/non-loopback, host redaction where appropriate, and whether an API key is configured, but never the key value.
- External collection cleanup is disabled by default unless the current store's pointer or generation history proves ownership and the user invoked an explicit destructive command.

### Qdrant pointer schema

The pointer file should follow the supporting pattern in @doc/architecture/patterns/qdrant-vector-store-placement-pattern and include at minimum:

```json
{
  "backend": "qdrant",
  "collectionUUID": "8f2c6a7b-91d4-4f6a-b9f7-2ef84d72a9c1",
  "collectionName": "kn_8f2c6a7b91d44f6ab9f72ef84d72a9c1",
  "schemaVersion": 1,
  "chunkVersion": 5,
  "embedding": {
    "provider": "ollama",
    "model": "qwen3-embedding:0.6b",
    "dimensions": 1024,
    "distance": "cosine"
  },
  "owner": {
    "projectId": "knowns-go",
    "storeRootFingerprint": "sha256:..."
  },
  "lastIndexedAt": null,
  "chunkCount": 0
}
```

### Config shape guidance

Exact field names can be finalized during planning, but config should support these semantics:

```json
{
  "semantic": {
    "enabled": true,
    "vectorStore": {
      "backend": "qdrant",
      "mode": "managed",
      "externalURL": "",
      "managedRoot": "~/.knowns/runtime/qdrant",
      "install": "lazy",
      "retention": {
        "previousGenerations": 1,
        "previousGenerationTTL": "72h"
      }
    }
  }
}
```

Config precedence should be:

```text
env override > project config > global settings > defaults
```

### Qdrant collection operations

The Qdrant client must support at least:

- Create collection with model dimensions and cosine distance.
- Upsert vectors with pointer-only payload metadata.
- Query nearest vectors for semantic search.
- Filter by payload fields such as source type, labels, status, or project/global scope.
- Delete collections for cleanup and privacy purge.
- Inspect collection existence and vector configuration for doctor/readiness.
- Attach the `api-key` header for external authenticated endpoints without logging or persisting the key.
- List collections only for diagnostics or cleanup candidate discovery; deletion still requires positive ownership proof.

### Search behavior

Semantic search should remain hybrid by default:

```text
keyword or BM25 results + Qdrant semantic results -> merge/rerank -> final results
```

When Qdrant is disabled or degraded, search returns keyword or BM25 results with semantic readiness metadata. Semantic-only commands, if any, may fail clearly when Qdrant is unavailable.

### Generation transaction and cleanup

A Qdrant reindex generation must follow this order:

1. Load the current active pointer and generation history.
2. Create a new collection UUID and collection name for the next generation.
3. Build the collection from canonical Knowns sources only.
4. Validate collection config, model, dimensions, distance, chunk version, owner metadata, payload metadata, and point/chunk count.
5. Atomically replace `.knowns/.search/qdrant.json` only after validation succeeds.
6. Append generation history that marks the new collection active and the previous active collection inactive.
7. Run best-effort cleanup using D7/FR-23 rules.

If any step before pointer activation fails, Knowns must preserve the previous pointer and previous active collection. Cleanup failure must not roll back a successful activation, but it must be reported as actionable degraded maintenance state.

- @task-dz8e9h [qdrant-default-vector-backend-01] Semantic backend config and Qdrant pointer metadata (done)
- @task-ahe9c1 [qdrant-default-vector-backend-02] Backend-neutral semantic index readiness (done)
- @task-q5r9vo [qdrant-default-vector-backend-03] Qdrant client, payloads, and collection isolation (done)
- @task-wi063q [qdrant-default-vector-backend-04] Managed Qdrant runtime and qdrant CLI (done)
- @task-lt9ton [qdrant-default-vector-backend-05] Lazy bootstrap, search fallback, and stale result validation (done)
- @task-3s983t [qdrant-default-vector-backend-06] Qdrant reindex generations and SQLite rebuild migration (in-progress)
- @task-lfbwdi [qdrant-default-vector-backend-07] Read-only doctor Qdrant readiness diagnostics (todo; read-only per approved @doc/specs/2026-07-25/knowns-doctor)

## Resolved Questions

- Retention precedence: max inactive generation count is a hard cap. Keep at most the most recent inactive generation; apply the 72h TTL to that retained inactive generation.
- Install command: `knowns qdrant install` is part of v1 and is the explicit managed installer. `knowns doctor` recommends it but does not run it.
- External Qdrant security: v1 supports API-key/TLS configuration. Plain HTTP is loopback-only; non-loopback endpoints require HTTPS; secrets are not persisted or logged.
- Cleanup safety: deletion requires positive ownership proof from this store's pointer/generation metadata or a managed ownership registry. Collection name shape or absence from the current pointer is insufficient.
- Doctor repair: v1 keeps doctor read-only to remain compatible with @doc/specs/2026-07-25/knowns-doctor. Repair actions are explicit commands outside doctor.

## Open Questions

- [ ] Should Qdrant payload indexes be created for all filter fields in v1 or only the minimum fields needed by current search/retrieve filters?
- [ ] How long should SQLite legacy fallback remain in code after Qdrant default ships?

## Out Of Scope

- History storage optimization.
- General `.knowns` directory taxonomy cleanup.
- Team server or multi-user authorization.
- Docker-managed Qdrant as the default runtime.
- Storing full raw chunk text in Qdrant payloads by default.
- Replacing BM25 or keyword search.
- Automatic mutating `knowns doctor --fix` repair in v1.
