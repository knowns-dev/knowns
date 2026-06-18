---
title: Memory Decision Review UI
description: Specification for trusted Memory lifecycle, first-class Decisions, semantic write review, retrieval filtering, and WebUI review flows.
createdAt: '2026-06-18T03:25:43.329Z'
updatedAt: '2026-06-18T07:21:22.222Z'
tags:
  - spec
  - approved
  - memory
  - decision
  - webui
---

## Overview

Add a trusted knowledge lifecycle for Memories and Decisions.

Memory remains a short, scoped, reviewable fact for fast agent recall. Decision becomes a first-class source-of-truth entity for agreed choices, including supersession chains when a later choice replaces an earlier one. Both entity types use semantic review before new writes become trusted, so agents and users do not accumulate duplicate or stale guidance.

This spec also refreshes the Memory WebUI around a Review Inbox first workflow, and adds a minimal but usable Decision UI for list, detail, and supersede flows.

Related context:
- @doc/specs/memory-auto-cleanup
- @doc/specs/runtime-memory-hook-injection
- @doc/specs/multi-store-semantic-memory-retrieval
- @doc/specs/semantic-reference-runtime
- @memory-gfh53b

## Locked Decisions

- D1: Phase one includes full Memory UI and a minimal usable Decision UI: list, detail, supersede flow, current/superseded badges, related docs/tasks, and historical guidance warnings.
- D2: Agent/MCP Memory add runs semantic duplicate check first. If matches are found, Knowns returns `review_required` and does not write the new memory until resolution.
- D3: Human-created Memory in WebUI/CLI also runs semantic review, but humans can explicitly override with `Create anyway`.
- D4: Decision add also uses a review gate. If an accepted/current decision is near-duplicate or conflicting, Knowns returns `review_required` and writes nothing until a resolution is selected.
- D5: Memory statuses are `proposed`, `active`, `stale`, `deprecated`, `archived`, `rejected`, and `merged`.
- D6: Memory `merged` is a lightweight tombstone pointing to the target memory and is excluded from default retrieval.
- D7: Decision statuses are `draft`, `accepted`, `superseded`, `rejected`, and `archived`.
- D8: WebUI users can create Decisions as `draft` or `accepted`; duplicate/conflict review still applies before writing.
- D9: Default retrieval/search uses only Memory `active` and Decision `accepted` entries that are not superseded. Review, historical, and debug modes may opt into other statuses.
- D10: The Memory WebUI first screen is a Review Inbox for proposed memories, duplicate review, stale TTL, missing source, and superseded-source warnings. Healthy/Archived/All views are secondary.
- D11: Memory Review Inbox supports only safe bulk actions: `verify`, `archive`, and `reject proposed`. Merge, update, source-link, and superseded-source repair are item-by-item.
- D12: Active Memory does not require sources, but missing sources create validation/review warnings and reduce trust.
- D13: Legacy memories migrate to `active` by default but receive validation/review warnings when missing source, `lastVerified`, TTL, or trust metadata.
- D14: Agent/MCP-created Memory without duplicate matches defaults to `proposed` and does not participate in default retrieval until activated.
- D15: Agent/MCP-created Decision can become `accepted` only when it has clear sources or related docs/tasks and no duplicate/conflict; otherwise it defaults to `draft`.
- D16: Decision IDs use date-time plus slug: `YYYYMMDD-HHMM-<slug>`, with collision handling by appending a short suffix. Decision references use `@decision/<id>`.
- D17: Canonical semantic references use singular slash namespaces: `@doc/<path>`, `@task/<id>`, `@memory/<id>`, `@decision/<id>`, and `@template/<name>`. Existing `@task-<id>` and `@memory-<id>` references remain supported as legacy aliases.
- D18: `confidence` is stored for validation, review, and retrieval trust. It is shown only in Memory/Decision detail or review contexts when it affects user action, not as a primary list badge.

## Requirements

### Functional Requirements

- FR-1: Extend Memory metadata with `status`, `confidence`, `lastVerified`, `ttlDays`, `sources`, and optional resolution metadata such as `mergedInto` and `rejectedReason`.
- FR-2: Memory status values must be limited to `proposed`, `active`, `stale`, `deprecated`, `archived`, `rejected`, and `merged`.
- FR-3: Legacy memories with missing lifecycle fields must load as `active` for compatibility while surfacing warnings for missing trust metadata.
- FR-4: Agent/MCP Memory add must perform semantic similarity review against existing Memories before writing.
- FR-5: If semantic Memory matches exceed the review threshold, Memory add must return a structured `review_required` response with the candidate, matches, and allowed resolutions, and must not write a new memory file.
- FR-6: If no Memory matches require review, agent/MCP Memory add must write the new memory as `proposed` by default.
- FR-7: Human WebUI/CLI Memory create must run the same semantic review and must allow an explicit `Create anyway` override.
- FR-8: Memory review resolutions must include at least `update_existing`, `archive_existing_create_new`, `create_proposed`, `reject_new`, and `merge_existing` where applicable.
- FR-9: Memory `merged` entries must be tombstones that point to the target memory and are excluded from default search/retrieval.
- FR-10: Memory verification must update `lastVerified`, refresh `updatedAt`, and optionally update `sources` when provided.
- FR-11: Memory cleanup/review commands must build on the existing cleanup behavior rather than adding an overlapping destructive garbage-collection command.
- FR-12: Default memory retrieval, runtime memory injection, and normal search must exclude Memory statuses other than `active` unless review/historical/debug options are explicitly enabled.
- FR-13: Memory validation must warn for missing/invalid status, invalid confidence, expired TTL, missing source, broken source refs, source decision superseded, too-long memory content, and old proposed memories.
- FR-14: Add first-class Decision storage under `.knowns/decisions/` with markdown body and frontmatter metadata.
- FR-15: Decision metadata must include `id`, `title`, `status`, `supersedes`, `supersededBy`, `tags`, `sources`, `relatedDocs`, `relatedTasks`, `createdAt`, and `updatedAt`.
- FR-16: Decision status values must be limited to `draft`, `accepted`, `superseded`, `rejected`, and `archived`.
- FR-17: Decision bodies must support sections for Context, Decision, Alternatives Considered, and Consequences.
- FR-18: Decision IDs and filenames must use `YYYYMMDD-HHMM-<slug>` format, with a short collision suffix when needed.
- FR-19: Decision semantic references must use `@decision/<id>` syntax.
- FR-20: Decision add must perform semantic review against existing Decisions before writing.
- FR-21: If a new Decision is near-duplicate or conflicting with an accepted/current Decision, Decision add must return `review_required` and must not write a decision file.
- FR-22: Decision review resolutions must include at least `supersede_existing`, `create_draft`, `link_as_related`, and `reject_new`.
- FR-23: Superseding a Decision must set the older decision to `superseded`, populate `supersededBy`, and populate `supersedes` on the newer decision.
- FR-24: Accepted superseded Decisions must remain historical records and must not be overwritten or deleted by default.
- FR-25: Default Decision retrieval/search must include only `accepted` Decisions that are not superseded.
- FR-26: Historical/review/debug retrieval modes must be able to include draft, superseded, rejected, and archived Decisions with clear status metadata.
- FR-27: Semantic references and validation must support Decision references, including broken refs and superseded-source warnings.
- FR-28: Canonical semantic references must support singular slash namespace syntax for tasks, memories, decisions, docs, and templates: `@task/<id>`, `@memory/<id>`, `@decision/<id>`, `@doc/<path>`, and `@template/<name>`.
- FR-29: Existing `@task-<id>` and `@memory-<id>` references must remain valid legacy aliases in parsing, validation, graph resolution, search context expansion, and WebUI rendering.
- FR-30: New UI copy, generated docs, generated tasks, and examples should prefer canonical slash namespace references.
- FR-31: WebUI Memory first screen must be a Review Inbox grouped by actionable reason: proposed, duplicate review, stale TTL, missing source, source missing, and source decision superseded.
- FR-32: WebUI Memory must provide secondary views for Healthy, Archived, and All memories.
- FR-33: WebUI Memory Review Inbox must support safe bulk actions only: verify, archive, and reject proposed.
- FR-34: WebUI Memory item detail must support item-by-item actions for merge, update existing, create proposed, link source, verify, archive, reject, and repair superseded-source issues.
- FR-35: WebUI Decision list must show current Decisions by default and allow filtering by draft, accepted, superseded, rejected, archived, and all.
- FR-36: WebUI Decision detail must show status, current/historical warning, supersedes/supersededBy links, related docs/tasks, sources, tags, and body sections.
- FR-37: WebUI Decision supersede flow must create or select a replacement Decision and update both ends of the supersession chain.
- FR-38: Runtime memory hooks must respect the same trusted retrieval defaults and must not inject proposed, stale, deprecated, archived, rejected, or merged Memories by default.

### Non-Functional Requirements

- NFR-1: The feature must avoid a large permission/team/hub system; lifecycle and review states are sufficient for this phase.
- NFR-2: No agent-created write should destructively delete or overwrite active/accepted knowledge by default.
- NFR-3: Existing memories must remain readable without manual migration.
- NFR-4: Semantic review must degrade safely when semantic search is unavailable by using lexical/title/category checks and conservative `proposed` or `draft` defaults.
- NFR-5: UI actions that can change source-of-truth guidance must be explicit, reversible where practical, and visually distinguish current from historical knowledge.
- NFR-6: Default retrieval must prefer trusted current guidance over historical or review-only records.
- NFR-7: The WebUI must remain task-oriented and dense enough for repeated review work; avoid decorative dashboard-only layouts.
- NFR-8: Reference syntax changes must be backward compatible; existing project docs, tasks, memories, and specs must continue validating without immediate migration.

## Acceptance Criteria

- [ ] AC-1: A legacy memory without lifecycle metadata loads as `active` and appears in validation/review warnings for missing trust metadata.
- [ ] AC-2: Agent/MCP Memory add with no semantic match writes a `proposed` memory and excludes it from default retrieval.
- [ ] AC-3: Agent/MCP Memory add with a near-duplicate returns `review_required` and no new memory file is created.
- [ ] AC-4: Human WebUI/CLI Memory create shows duplicate candidates and allows an explicit `Create anyway` override.
- [ ] AC-5: Resolving a duplicate with `update_existing` updates only the selected existing memory and records verification metadata.
- [ ] AC-6: Resolving a duplicate with `archive_existing_create_new` archives the older memory and creates the replacement according to the selected status.
- [ ] AC-7: Resolving a merge creates a `merged` tombstone that points to the target memory and is not returned by default search/retrieval.
- [ ] AC-8: Default search/retrieval/runtime injection excludes Memory statuses other than `active`.
- [ ] AC-9: Validation emits warnings for expired TTL, missing source, invalid status/confidence, broken source refs, source decision superseded, too-long memory, and old proposed memory.
- [ ] AC-10: Decision create with no duplicate/conflict writes `accepted` only when sources or related docs/tasks are present; otherwise it writes `draft`.
- [ ] AC-11: Decision create with an accepted/current near-duplicate or conflict returns `review_required` and writes no file.
- [ ] AC-12: Superseding a Decision updates `supersedes` and `supersededBy` on the correct records and marks the old Decision `superseded`.
- [ ] AC-13: Default search/retrieval includes accepted current Decisions and excludes superseded/historical Decisions unless explicitly requested.
- [ ] AC-14: A Memory sourced from a superseded Decision appears in validation and the Memory Review Inbox with a source-superseded warning.
- [ ] AC-15: Memory WebUI opens to Review Inbox and groups items by proposed, duplicate, stale TTL, missing source, source missing, and source superseded.
- [ ] AC-16: Memory Review Inbox bulk actions are limited to verify, archive, and reject proposed.
- [ ] AC-17: Memory item detail exposes item-by-item merge/update/source repair actions.
- [ ] AC-18: Decision WebUI lists current Decisions by default and displays status filters.
- [ ] AC-19: Decision detail displays current/historical status, supersession links, related docs/tasks, sources, tags, and body sections.
- [ ] AC-20: Decision WebUI supersede flow creates or selects a replacement and shows the old Decision as historical afterward.
- [ ] AC-21: A new Decision created at 2026-06-18 10:24 with title `Use Qdrant as default vector DB` receives an ID like `20260618-1024-use-qdrant-as-default-vector-db`.
- [ ] AC-22: A doc, memory, or task containing `@decision/20260618-1024-use-qdrant-as-default-vector-db` validates when the Decision exists and warns when it does not.
- [ ] AC-23: `@task/<id>` and `@memory/<id>` parse and resolve as canonical references in validation, graph, retrieval expansion, and WebUI rendering.
- [ ] AC-24: Existing `@task-<id>` and `@memory-<id>` references continue to validate and resolve without migration.
- [ ] AC-25: New UI-generated examples and links use canonical slash namespace references.
- [ ] AC-26: Confidence is visible in detail/review contexts when it affects action, but is not shown as a primary badge in default list rows.

## Scenarios

### Scenario 1: Agent proposes a new Memory with no duplicate

**Given** semantic search finds no similar active memory
**When** an agent calls Memory add with a new fact
**Then** Knowns writes the memory with status `proposed`
**And** default retrieval does not return it until it is activated.

### Scenario 2: Agent tries to add a duplicate Memory

**Given** an active memory says the project uses Qdrant as the default vector DB
**When** an agent tries to add a semantically equivalent memory
**Then** Knowns returns `review_required` with the similar memory candidate
**And** no new memory file is written.

### Scenario 3: Human overrides duplicate warning

**Given** WebUI Memory create finds similar memories
**When** the user selects `Create anyway`
**Then** Knowns creates the memory with explicit override metadata
**And** the new memory remains visible for review according to its chosen status.

### Scenario 4: Memory source points to superseded Decision

**Given** a memory sources `@decision/20260401-0900-use-chroma-as-default-vector-db`
**And** that Decision is superseded by `@decision/20260618-1024-use-qdrant-as-default-vector-db`
**When** validation or the Memory Review Inbox runs
**Then** the memory is flagged with a source-superseded warning
**And** the UI offers item-level source repair or archive actions.

### Scenario 5: New Decision replaces an old Decision

**Given** `Use Chroma as default vector DB` is accepted and current
**When** a user creates `Use Qdrant as default vector DB`
**And** chooses to supersede the Chroma Decision
**Then** the Chroma Decision becomes `superseded`
**And** the Qdrant Decision becomes the current accepted Decision.

### Scenario 6: Search defaults to current guidance

**Given** current Qdrant and historical Chroma Decisions both match `vector db`
**When** a user or agent runs default search/retrieval
**Then** only the current accepted Qdrant Decision is returned as guidance
**And** the historical Chroma Decision appears only with historical/debug options.

### Scenario 7: Review Inbox bulk action

**Given** the Memory Review Inbox has ten proposed memories
**When** the user selects multiple proposed memories and chooses reject
**Then** those memories become `rejected`
**And** merge/update/source repair actions remain unavailable as bulk actions.

### Scenario 8: Canonical and legacy refs coexist

**Given** a task references a memory with `@memory/<id>`
**And** another task references a memory with legacy `@memory-<id>`
**When** validation and graph resolution run
**Then** both references resolve to the same memory entity.

## Technical Notes

- Current Memory model lives at `internal/models/memory.go` and should be extended rather than replaced.
- Existing Memory cleanup behavior in @doc/specs/memory-auto-cleanup should evolve into the review model instead of introducing overlapping destructive cleanup commands.
- Current runtime memory hook path already uses `knowns runtime-memory hook`; it must consume the same trusted Memory filter used by retrieval.
- Validation already has an internal memory scope; public CLI/MCP validation scopes should expose Memory/Decision where appropriate.
- Decision support should integrate with search indexing, retrieval, semantic references, graph resolution, CLI, MCP, server API, and WebUI, but advanced conflict detection and heavy graph UI are deferred.
- Semantic similarity thresholds and scoring weights should be implementation details validated with fixtures; product behavior is the review gate and allowed resolutions.
- Destructive deletion remains explicit/manual and is not a default resolution for agent-created Memory or Decision flows.
- Decision IDs should be generated from the project-local creation time used by the CLI/server, formatted as `YYYYMMDD-HHMM`, followed by a sanitized title slug. If a file with the generated ID already exists, append a short stable suffix.

## Task Links

Generated implementation tasks:

- @task/2c9t78 memory-decision-review-ui-01 | Add Memory lifecycle metadata and validation - done
- @task/z8h8df memory-decision-review-ui-02 | Add Memory semantic review and resolution backend - done
- @task/yken4b memory-decision-review-ui-03 | Add Decision storage and lifecycle commands - done
- @task/xxdnu5 memory-decision-review-ui-04 | Add Decision semantic review and supersession rules - done
- @task/hdz9x0 memory-decision-review-ui-05 | Apply trusted retrieval filters for Memory and Decision - done
- @task/7kwtk0 memory-decision-review-ui-06 | Normalize semantic references and Decision ref validation - done
- @task/9ia5dw memory-decision-review-ui-07 | Rebuild Memory WebUI around Review Inbox - done
- @task/h1oeud memory-decision-review-ui-08 | Add Decision WebUI list, detail, and supersede flow - done
## Open Questions

None.
