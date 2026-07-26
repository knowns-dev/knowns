---
title: Decision Taxonomy Workflow Enforcement
description: Specification for separating Spec Decisions from System Decisions, enforcing both in workflows, deprecating Decision Memories, and migrating legacy guidance safely.
createdAt: '2026-07-22T17:08:28.261Z'
updatedAt: '2026-07-22T17:12:02.007Z'
tags:
  - spec
  - approved
  - decision
  - workflow
  - migration
---

## Overview

Knowns currently uses the word "Decision" for three different things: rules locked inside a feature spec, first-class Decision records under `.knowns/decisions/`, and legacy Memories whose category is `decision`. This ambiguity leaves first-class Decisions disconnected from normal workflows and causes runtime prompt capture to produce noisy Decision Memories.

This feature establishes two supported Decision domains:

1. **Spec Decision** — a scoped execution rule stored canonically in a spec's `Locked Decisions` section and mandatory for every task and agent implementing that spec.
2. **System Decision** — a first-class durable record of a project-wide architecture, product, workflow, storage, API, naming, or compatibility change, stored under `.knowns/decisions/` with review, verification, and supersession history.

Memory entries with `category: decision` become legacy-only. New writes must use the System Decision lifecycle instead.

Related foundation: @doc/specs/2026-06-18/memory-decision-review-ui.

## Locked Decisions

- D1: Spec Decisions and System Decisions are separate domains with different scope, storage, lifecycle, and enforcement.
- D2: Spec Decisions remain canonical only inside the linked spec's `Locked Decisions` section with stable document-scoped IDs such as D1 and D2. Tasks link to the spec and do not duplicate these rules.
- D3: System Decisions are first-class records under `.knowns/decisions/` and represent durable project evolution, not individual implementation steps or progress notes.
- D4: A System Decision is created as `draft` when a system-level change is approved or discovered. It becomes `accepted` only after the related implementation has passed verification. An older accepted Decision is superseded only when its verified replacement is accepted.
- D5: Agent workflows retrieve relevant accepted/current System Decisions on demand. They do not inject every Decision into every prompt.
- D6: Memory entries with `category: decision` are legacy. New Memory writes using that category are rejected with actionable guidance to create a System Decision.
- D7: Legacy Decision Memory migration is review-driven and reversible. Knowns must not bulk-convert entries automatically.
- D8: Existing legacy entries remain readable during transition. They leave default guidance only after replacement System Decisions are available and workflow consumption is active.
- D9: Runtime prompt capture must not infer or persist System Decisions automatically from ordinary user prompts.
- D10: Every workflow implementing a linked spec must read and verify all Spec Decisions from the canonical spec before completing work.

## Requirements

### Functional Requirements

- FR-1: Documentation, UI copy, CLI/MCP help, and agent instructions must consistently distinguish Spec Decision, System Decision, and Legacy Decision Memory.
- FR-2: Spec Decisions must use stable IDs unique within their spec and remain in the canonical `Locked Decisions` section.
- FR-3: Approved Spec Decisions must be treated as immutable execution rules; modifying them must return the spec to a review state and require renewed approval.
- FR-4: Tasks generated from a spec must retain a valid spec link rather than copying Spec Decision text.
- FR-5: `kn-plan`, `kn-flow`, `kn-implement`, `kn-review`, and `kn-verify` must load the linked spec's Locked Decisions and report compliance or a concrete conflict.
- FR-6: `kn-spec`, `kn-plan`, `kn-flow`, `kn-implement`, `kn-review`, and `kn-verify` must retrieve relevant accepted/current System Decisions using the feature/task query and trusted retrieval filters.
- FR-7: Workflow retrieval must remain relevance-bounded and must not serialize all System Decisions into every context.
- FR-8: A spec that introduces a system-level change must declare its System Decision impact as either no impact, a linked existing Decision, or a linked draft replacement/new Decision.
- FR-9: System Decision creation must default to `draft` before implementation verification.
- FR-10: Accepting a draft System Decision must require related source evidence and successful verification of its linked spec/tasks.
- FR-11: Supersession must atomically mark the old Decision `superseded`, populate `supersededBy`, populate `supersedes` on the accepted replacement, and preserve both records.
- FR-12: The first-class Decision surface must expose creation, review, acceptance, linkage, retrieval, and supersession through CLI, MCP, and WebUI with consistent semantics.
- FR-13: MCP `initial`, project readiness, and help discovery must show Decision counts/capabilities and include the Decision tool or workflow guidance.
- FR-14: Memory creation must reject normalized category `decision` across CLI, MCP, API/WebUI, review resolutions, and other normal write paths.
- FR-15: Rejection responses must identify `decision` as a legacy Memory category and direct the caller to the equivalent first-class Decision command/tool/UI.
- FR-16: Existing Legacy Decision Memories must remain loadable and inspectable; normal editing may only archive, reject, reclassify, or migrate them, not create another active/proposed Legacy Decision Memory.
- FR-17: Runtime Memory capture must stop producing `Project workflow decision` Memories and must not create first-class System Decisions automatically.
- FR-18: Runtime and search paths must explicitly distinguish temporary legacy compatibility from supported System Decision retrieval.
- FR-19: Migration must offer a no-write preview that inventories Legacy Decision Memories, status, likely noise, duplicate groups, source availability, and proposed resolution.
- FR-20: Migration resolutions must include at least: create/link a System Decision, consolidate duplicates into one System Decision, reclassify as a non-decision Memory, archive/reject as noise, and leave unchanged for later review.
- FR-21: Creating a System Decision from a legacy entry must require explicit review, preserve provenance with the legacy Memory reference, and avoid accepting unsourced guidance automatically.
- FR-22: After a replacement Decision is accepted, the migrated Memory must be archived or otherwise excluded from default retrieval while retaining a traceable link to `@decision/<id>`.
- FR-23: Migration must be idempotent and must not create duplicate System Decisions when rerun.
- FR-24: Transition ordering must prevent a guidance gap: block new legacy writes, enable System Decision consumption, migrate accepted guidance, then remove migrated legacy entries from default guidance.
- FR-25: Validation must report new Legacy Decision Memory writes, broken System Decision links, accepted Decisions without verification/source evidence, invalid supersession chains, missing spec links, and unverified Spec Decision compliance.
- FR-26: SDD verification output must include Spec Decision compliance and System Decision impact alongside task and acceptance-criteria coverage.
- FR-27: Built-in skill source and synced runtime copies must express the same Decision rules without continuing to recommend `memory add category=decision`.

### Non-Functional Requirements

- NFR-1: Legacy migration must be preview-first, explicit, reversible, and safe to rerun.
- NFR-2: Existing repositories containing Legacy Decision Memories must continue to load without startup or parsing failures.
- NFR-3: Workflow Decision retrieval must remain bounded by query relevance and trusted lifecycle status.
- NFR-4: Supersession and acceptance transitions must be atomic enough to avoid two current conflicting System Decisions after partial failure.
- NFR-5: Error messages must be actionable and consistent across CLI, MCP, API, and WebUI.
- NFR-6: The feature must include focused unit, integration, workflow-instruction, migration, and end-to-end verification coverage.

## Acceptance Criteria

- [ ] AC-1: Product documentation and workflow instructions define exactly two supported Decision domains and label Memory-category Decisions as legacy.
- [ ] AC-2: A task linked to a spec cannot pass workflow verification when a Locked Decision is unread, violated, or unassessed.
- [ ] AC-3: Editing an approved spec's Locked Decisions returns it to review and prevents silent continuation under stale approval.
- [ ] AC-4: Relevant accepted/current System Decisions appear in workflow context, while unrelated or historical Decisions do not.
- [ ] AC-5: A System Decision remains draft before implementation verification and can become accepted only with verified linked evidence.
- [ ] AC-6: Accepting a replacement atomically creates a valid supersession chain and removes the old Decision from default retrieval.
- [ ] AC-7: MCP initial/status/help exposes first-class Decision availability and counts.
- [ ] AC-8: CLI, MCP, API, WebUI, and Memory review paths reject every attempted new Memory with normalized category `decision` and direct the caller to System Decision creation.
- [ ] AC-9: Runtime prompt capture no longer creates generic `Project workflow decision` Memories.
- [ ] AC-10: Existing Legacy Decision Memories remain readable after the guard is introduced.
- [ ] AC-11: Migration preview performs no writes and reports deterministic candidate/resolution data.
- [ ] AC-12: Confirmed migration creates provenance-linked System Decisions and archives/reclassifies/rejects legacy entries according to the selected resolution.
- [ ] AC-13: Re-running migration does not duplicate Decisions or corrupt legacy records.
- [ ] AC-14: Default retrieval contains no migrated Legacy Decision Memory once its accepted System Decision replacement is active.
- [ ] AC-15: SDD validation reports Spec Decision compliance and System Decision impact.
- [ ] AC-16: Tests cover backward compatibility, rejection routing, runtime capture, workflow retrieval, acceptance, supersession, migration preview/apply, rollback/error behavior, and instruction synchronization.

## Scenarios

### Scenario 1: Agent implements a spec

**Given** an approved spec containing D1, D2, and D3
**When** an agent plans, implements, reviews, or verifies a linked task
**Then** it reads the canonical Locked Decisions, reports compliance, and does not copy their text into the task.

### Scenario 2: Spec changes a system contract

**Given** a spec proposes removing Memories from the system
**When** the system-level change is approved
**Then** Knowns creates or links a draft System Decision describing the chosen change, rationale, consequences, migration, and related spec/tasks.

### Scenario 3: System Decision becomes current guidance

**Given** a draft System Decision linked to completed implementation
**When** all required verification passes
**Then** it may become accepted and supersede the previous current Decision atomically.

### Scenario 4: Caller creates a Decision Memory

**Given** a CLI, MCP, API, WebUI, runtime, or review caller submits a new Memory with category `decision`
**When** the write is validated
**Then** Knowns rejects it without persisting a Memory and points the caller to first-class System Decision creation.

### Scenario 5: Migration encounters prompt-capture noise

**Given** a proposed Legacy Decision Memory containing a question, worker instruction, command, or log
**When** migration preview evaluates it
**Then** it recommends archive/reject rather than creating a System Decision, and performs no write without confirmation.

### Scenario 6: Migration encounters durable guidance

**Given** an active Legacy Decision Memory with a verifiable source
**When** a reviewer approves migration
**Then** Knowns creates or links a System Decision, records provenance, and archives the legacy entry only after the replacement is accepted.

### Scenario 7: Duplicate legacy guidance

**Given** multiple Legacy Decision Memories describe the same current rule
**When** migration review groups them
**Then** one canonical System Decision is created and every migrated legacy entry points to that record.

### Scenario 8: Unrelated System Decisions

**Given** many accepted System Decisions exist
**When** a workflow starts for a narrow feature
**Then** only relevant current Decisions are retrieved, with an explicit empty result when none apply.

## Technical Notes

- Current repository inventory at specification time: 59 project Memories with category `decision`; 46 are proposed and 13 active.
- Of the 46 proposed entries, 45 are generic `Project workflow decision` prompt captures. The remaining LSP daemon entry is a plausible migration candidate.
- The 13 active entries contain two research conclusions and two near-duplicate pairs; roughly nine canonical System Decision candidates remain after review, plus the LSP daemon candidate.
- Known duplicate groups include the MCP initial/help guidance pair and the BM25 public-compatibility pair.
- The central Memory review service currently trims but does not restrict category values.
- Runtime capture currently infers `Project workflow decision` with category `decision`; this is the primary source of noisy proposed entries.
- WebUI Memory creation currently accepts free-form category text.
- This spec is itself a system-level workflow change. It is the bootstrap source for a draft System Decision, which should be accepted only after this spec is implemented and verified.
- System Decisions capture the chosen durable change and rationale. Implementation steps remain in Tasks and implementation notes.

## Task Links

- @task-k9rnnd [decision-taxonomy-workflow-enforcement-01] Harden System Decision lifecycle and retrieval
- @task-bz8dr3 [decision-taxonomy-workflow-enforcement-02] Enforce Spec Decisions across SDD workflows
- @task-4karwl [decision-taxonomy-workflow-enforcement-03] Block legacy Decision Memory writes and runtime noise
- @task-zuxfq0 [decision-taxonomy-workflow-enforcement-04] Add review-driven legacy Decision migration
- @task-o209dm [decision-taxonomy-workflow-enforcement-05] Align Decision CLI MCP WebUI and readiness surfaces
- @task-g7vvnw [decision-taxonomy-workflow-enforcement-06] Verify end-to-end Decision transition

## Open Questions

None. Product decisions were confirmed during exploration.


## System Decision Impact

- Impact: draft new System Decision.
- Decision: @decision/20260723-0011-separate-spec-decisions-from-system-decisions-and-retire-decision-memory-writes.
- Acceptance gate: keep draft until all linked implementation tasks and SDD verification pass.
