---
title: Decision Processing Flow
description: Specification for workflow-first System Decision capture, persistent review, current-truth reading, and separation of Spec Decisions and Legacy Decision Memory migration.
createdAt: '2026-07-23T18:48:02.849Z'
updatedAt: '2026-07-23T18:56:45.164Z'
tags:
  - spec
  - approved
  - decision
  - workflow
  - webui
---

## Overview

This specification defines the processing flow and information architecture for Decisions before any further visual redesign. It separates four concerns that are currently mixed in one surface: creating a candidate, resolving review, reading current guidance, and migrating Legacy Decision Memories.

The flow refines the WebUI behavior described by @doc/specs/2026-06-18/memory-decision-review-ui and the Decision surface requirement in @doc/specs/2026-07-23/decision-taxonomy-workflow-enforcement. It does not change the established Spec Decision/System Decision taxonomy, trusted retrieval defaults, evidence requirements, or atomic supersession contract.

## Locked Decisions

- D1: The default Decision surface is a read-only view of current accepted System Decisions. It is not the primary place for creating, accepting, superseding, or migrating records.
- D2: System Decision candidates originate primarily from task/spec workflow completion when durable project guidance was added, changed, or removed. Manual creation remains a secondary escape hatch.
- D3: Spec Decisions remain canonical inside the linked spec and are enforced as implementation rules. They are not copied into or mixed with the System Decision ledger.
- D4: System Decision candidates are persisted across sessions until they are accepted, linked to existing guidance, used to replace existing guidance, rejected, or archived.
- D5: Legacy Decision Memory migration is a separate Settings/Tools workflow and is never a primary Decision-page action.
- D6: Human review remains required before a candidate changes current guidance. Passing automated evidence and conflict checks makes a candidate ready for review; it does not silently accept it.
- D7: The processing flow must preserve the existing atomic acceptance/supersession guarantee and current-only default retrieval.

## Processing Model

```text
Spec authoring
  -> Spec Decision saved in the spec Locked Decisions section
  -> Implementation workflow must follow the rule
  -> Task/spec verification completes

Task or spec workflow completion
  -> Did durable project guidance change?
     -> No: finish workflow without a System Decision candidate
     -> Yes: persist a System Decision candidate with provenance

Persisted candidate
  -> Run evidence, source, linked-task, duplicate, and conflict checks
     -> Missing or unreadable evidence: Needs evidence
     -> Duplicate or conflict detected: Needs resolution
     -> Checks pass: Ready for review

Human review
  -> Accept new: candidate becomes Current
  -> Replace existing: candidate becomes Current and old Decision becomes Historical atomically
  -> Link to existing: preserve provenance on the existing Decision; do not create duplicate current guidance
  -> Reject: candidate becomes Rejected and never enters current retrieval

Reading
  -> Current: accepted, non-superseded System Decisions only
  -> History: superseded, rejected, and archived records
  -> Review Inbox: unresolved persisted candidates only

Legacy migration
  -> Settings/Tools
  -> Preview, review one item, apply or rollback
  -> Never mixed into normal candidate review or current reading
```

## Information Architecture

### Decisions / Current

The default route and primary reading surface.

- Shows only accepted, non-superseded System Decisions.
- Supports search and relevance-bounded filtering without exposing lifecycle operations as primary controls.
- Opens a read-only Decision detail containing rationale, provenance, verification, sources, related work, and lineage.
- Offers contextual navigation to a replacement or historical predecessor without turning the detail into an editing workspace.

### Decisions / Review Inbox

The operational surface for persisted System Decision candidates.

- Groups candidates by actionable state: Needs evidence, Needs resolution, and Ready for review.
- Shows one candidate review at a time.
- Keeps the candidate, detected matches, evidence state, and resulting lifecycle impact visible together.
- Exposes only the resolutions valid for the selected candidate.
- Supports no destructive bulk acceptance or bulk supersession.

### Decisions / History

The audit and recovery surface.

- Shows superseded, rejected, and archived Decisions.
- Clearly identifies why a record is historical and links to current replacements when present.
- Remains read-only except for narrowly scoped recovery actions defined by lifecycle policy.

### Settings / Legacy Decision Migration

A separate administrative tool.

- Provides preview-first, one-record-at-a-time migration review.
- Preserves rollback, journal state, provenance, and idempotency.
- Does not appear as a Decision ledger tab or primary page CTA.

### Spec / Locked Decisions

The canonical home of Spec Decisions.

- Spec Decisions remain document-scoped rules with stable IDs.
- Tasks and implementation workflows link to the spec instead of duplicating rule text.
- A completed implementation may produce a System Decision candidate only when durable system guidance changed.

## State Model

The UX state model initially maps onto existing backend lifecycle data rather than requiring new canonical Decision statuses.

| UX state | Canonical mapping | Meaning |
| --- | --- | --- |
| Proposed | persisted `draft` | Candidate exists but automated checks have not established readiness |
| Needs evidence | `draft` plus failed/missing verification inputs | User or workflow must add readable sources or completed linked work |
| Needs resolution | persisted candidate plus duplicate/conflict review metadata | User must choose Link, Replace, Reject, or an explicitly allowed separate-draft path |
| Ready for review | `draft` with required checks passing | Human can review lifecycle impact and accept |
| Current | `accepted` and not superseded | Participates in default retrieval |
| Historical | `superseded` or has a current replacement | Preserved for provenance, excluded from default retrieval |
| Rejected | `rejected` | Reviewed candidate that must not become current |
| Archived | `archived` | Retained record outside active lifecycle |

Review metadata and readiness must be durable enough to reconstruct the Review Inbox after restart. If the existing storage model cannot persist these derived states, implementation planning must introduce the smallest explicit candidate/review persistence model rather than relying on page-local state.

## Requirements

### Functional Requirements

- FR-1: Task/spec completion workflows must evaluate whether durable project guidance was added, changed, or removed before completing.
- FR-2: A workflow with no System Decision impact must complete without creating a candidate.
- FR-3: A workflow with System Decision impact must persist a candidate linked to the originating task/spec and available sources.
- FR-4: Candidate creation must run evidence, readable-source, completed-task, duplicate, and conflict checks without silently accepting the candidate.
- FR-5: Candidates must remain discoverable across sessions until a terminal or current resolution is recorded.
- FR-6: The Review Inbox must derive or persist the actionable states Needs evidence, Needs resolution, and Ready for review.
- FR-7: Needs evidence must identify the exact missing, broken, unreadable, or incomplete inputs and provide a path to repair them.
- FR-8: Needs resolution must show relevant existing Decisions, relationship confidence/reason, and only valid resolutions.
- FR-9: Accept new must transition a verified candidate to accepted/current guidance.
- FR-10: Replace existing must accept the verified replacement and supersede the selected current Decision atomically while preserving both records and lineage.
- FR-11: Link to existing must attach candidate provenance/evidence to the selected Decision and must not create duplicate current guidance.
- FR-12: Reject must persist the reviewed rejection outcome and exclude the candidate from default retrieval.
- FR-13: The default Decision route must show only current accepted non-superseded System Decisions.
- FR-14: Current Decision detail must be read-only and show rationale, evidence, verification, related work, and lineage.
- FR-15: Superseded, rejected, and archived records must live under History rather than as equal-priority filters on the Current surface.
- FR-16: Manual System Decision creation must remain available as a secondary action and must enter the same persisted candidate/review flow.
- FR-17: Spec Decisions must remain in the spec and must not be materialized as System Decision ledger rows merely for display.
- FR-18: Legacy Decision Memory migration must be reachable from Settings/Tools and absent from the primary Decision reading and review flows.
- FR-19: Legacy migration must retain its existing preview, explicit per-item apply, rollback, provenance, and idempotency guarantees.
- FR-20: Default search/retrieval must continue to use only accepted non-superseded System Decisions.
- FR-21: Refreshing, navigating away, restarting the server, or opening another client must not lose unresolved candidates or their review state.
- FR-22: Every consequential review action must show the target, resulting current/historical state, evidence outcome, and cancel/confirm boundary before mutation.

### Non-Functional Requirements

- NFR-1: Current truth must be understandable without exposing operational controls by default.
- NFR-2: Lifecycle meaning must be conveyed by text and structure, not color alone.
- NFR-3: Review actions must be keyboard accessible, focus-safe, and usable at narrow mobile widths.
- NFR-4: Candidate persistence and resolution must be idempotent and safe across retries or concurrent clients.
- NFR-5: Acceptance and supersession must remain atomic enough to prevent conflicting current guidance after partial failure.
- NFR-6: The flow must degrade conservatively when semantic review is unavailable by keeping candidates non-current and using lexical checks.
- NFR-7: Existing accepted Decisions, historical records, references, and Legacy Decision Memories must remain readable throughout migration.
- NFR-8: UI implementation must use progressive disclosure and avoid combining reading, candidate review, and legacy administration into one workspace.

## Acceptance Criteria

- [ ] AC-1: Completing a task/spec with no durable guidance change records no System Decision candidate.
- [ ] AC-2: Completing a task/spec with a durable guidance change creates a persisted candidate linked to the originating work.
- [ ] AC-3: An unresolved candidate remains in the Review Inbox after page reload and server restart.
- [ ] AC-4: A candidate with missing evidence appears as Needs evidence with concrete repair guidance and cannot be accepted.
- [ ] AC-5: A candidate with a duplicate/conflict appears as Needs resolution with valid Link, Replace, or Reject choices.
- [ ] AC-6: A verified candidate appears as Ready for review but does not become current without human confirmation.
- [ ] AC-7: Accept new makes the candidate current and visible in Current while preserving provenance.
- [ ] AC-8: Replace existing atomically makes the replacement current, marks the old Decision historical, and preserves both lineage links.
- [ ] AC-9: Link to existing adds provenance without creating a second current Decision.
- [ ] AC-10: Reject persists the outcome and excludes the candidate from Current/default retrieval.
- [ ] AC-11: Decisions opens to Current and exposes no create, supersede, acceptance, or legacy migration form in the primary reading surface.
- [ ] AC-12: Review Inbox, History, and Legacy Migration are structurally separate destinations with distinct user goals.
- [ ] AC-13: Spec Decisions remain visible and enforceable in their spec without appearing as System Decision ledger entries.
- [ ] AC-14: Manual creation is secondary and enters the same persisted review pipeline.
- [ ] AC-15: The complete flow is keyboard accessible, mobile reachable, and reports lifecycle state without relying on color.

## Scenarios

### Scenario 1: Workflow completes without Decision impact

**Given** a task completes without changing durable guidance
**When** the completion workflow evaluates System Decision impact
**Then** it records no candidate and completes normally.

### Scenario 2: Workflow proposes new guidance

**Given** verified work introduced durable guidance
**When** the workflow completes
**Then** it persists a candidate with task/spec provenance and runs review checks
**And** the candidate appears in Review Inbox rather than Current.

### Scenario 3: Candidate lacks evidence

**Given** a persisted candidate has no readable source or completed linked work
**When** it is evaluated
**Then** it appears as Needs evidence with explicit blockers
**And** Accept is unavailable until the blockers are resolved.

### Scenario 4: Candidate conflicts with current guidance

**Given** a candidate conflicts with a current Decision
**When** review checks finish
**Then** the candidate appears as Needs resolution with the matched Decision and valid relationship choices.

### Scenario 5: Reviewer accepts new guidance

**Given** a candidate is Ready for review
**When** a human confirms Accept new
**Then** it becomes current, enters default retrieval, and leaves Review Inbox.

### Scenario 6: Reviewer replaces current guidance

**Given** a verified candidate replaces an existing current Decision
**When** a human confirms Replace existing
**Then** the candidate becomes current and the old Decision becomes historical in one lifecycle transition.

### Scenario 7: Reviewer links to existing guidance

**Given** a candidate restates an existing current Decision
**When** the reviewer selects Link to existing
**Then** provenance is attached to the existing Decision and no duplicate current record is created.

### Scenario 8: Candidate survives restart

**Given** an unresolved candidate exists
**When** the page or server restarts
**Then** the same candidate, actionable state, matches, and evidence blockers remain available.

### Scenario 9: User reads current truth

**Given** the user opens Decisions
**When** the page loads
**Then** only current System Decisions are presented by default
**And** operational review or migration controls do not compete with reading.

### Scenario 10: User migrates legacy guidance

**Given** Legacy Decision Memories remain
**When** an administrator opens Settings/Legacy Decision Migration
**Then** migration runs through its preview/review/apply/rollback workflow without entering Current or Review Inbox as a normal candidate unless explicitly converted.

## Technical Notes

- Existing Decision statuses remain `draft`, `accepted`, `superseded`, `rejected`, and `archived` unless planning proves a persisted candidate/review entity is required.
- Current page-local `pendingReview` state is insufficient for AC-3 and AC-8; planning must identify durable storage for candidate review metadata and resolutions.
- Existing verified acceptance and atomic supersession services should remain the canonical mutation path.
- This spec supersedes the previous WebUI assumption that creation, supersession, all lifecycle filters, and Legacy Decision Memory migration belong on one Decision ledger surface. It does not supersede the underlying lifecycle or taxonomy requirements.
- UI topology, color, modal usage, and component styling are intentionally deferred until this processing flow is approved.

## Task Links

- @task/5awjhs — Persist Decision candidate review state (AC-3–AC-6)
- @task/ly03u5 — Resolve persisted Decision candidates safely (AC-7–AC-10, AC-14)
- @task/5pj5yh — Capture System Decision impact at workflow completion (AC-1, AC-2, AC-13)
- @task/me2fmp — Separate Decision Current, Review Inbox, History, and Legacy Migration UI (AC-3–AC-15)

## Open Questions

None. The processing flow, ownership boundary, persistence requirement, and surface separation are locked for this version.
