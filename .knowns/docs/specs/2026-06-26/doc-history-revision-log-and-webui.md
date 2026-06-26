---
title: Doc History Revision Log and WebUI
description: Specification for audit-linked doc revision history with section-level diffs, bounded retention, and WebUI compare/restore flows.
createdAt: '2026-06-26T04:16:50.076Z'
updatedAt: '2026-06-26T04:24:15.006Z'
tags:
  - spec
  - approved
  - docs
  - history
  - webui
  - audit
---

## Overview

Knowns should preserve document history as a first-class revision log rather than relying only on git history or MCP audit events. The feature replaces the current full-snapshot-per-version behavior with a bounded hybrid revision model: section-level diffs where possible, fallback full-content diffs when section attribution is not available, and periodic checkpoint snapshots for reliable restore.

The WebUI should expose this history inside the document reading/editing experience through a History drawer, timeline entries, diff inspection, and restore actions. MCP audit remains a separate observability layer, but doc history entries should carry light audit links when available so users can understand both what changed and which source caused the change.

Related context:

- @doc/architecture/patterns/storage
- @doc/features/git-modes
- @doc/specs/mcp-audit-trail-and-tool-stats
- @doc/specs/doc-inline-annotation

## Locked Decisions

- D1: v1 is full audit-linked scope: doc history storage, WebUI history/diff/restore, and light linkage to MCP audit/actor metadata.
- D2: v1 stores section-level diffs when a changed section can be identified; it falls back to a full-content diff when section attribution is unavailable.
- D3: v1 supports both restore section and restore whole doc from history; compare/copy remain supporting actions in the diff view.
- D4: v1 applies bounded retention by default to avoid unbounded storage growth and reduce long-term sensitive-content retention.
- D5: doc history stores a light audit link when available (`auditEventId`, `sessionId`, `actor`, `source`); history remains valid if the linked audit event is missing, rotated, or unavailable.
- D6: retention uses a combined policy: maximum versions per doc plus maximum age; entries beyond policy are compacted or purged according to the configured behavior.

## Requirements

### Functional Requirements

- FR-1: The system must record a doc history revision whenever a document is created, updated, renamed, restored, or deleted through CLI, MCP, or WebUI write paths.
- FR-2: Each revision must include stable metadata: revision ID, stable doc identity, current path, timestamp, actor/source when known, base hash, new hash, changed fields, and whether the revision is a checkpoint.
- FR-3: Doc history must use a stable document identity so renaming a doc does not split history across path-keyed files.
- FR-4: Content changes must be stored as section-level diffs when the changed section can be identified.
- FR-5: If section attribution is not available, content changes must be stored as a whole-content diff with enough metadata to compare and restore safely.
- FR-6: The system must store checkpoint snapshots at creation and at configured intervals or large-change thresholds so restore does not depend on replaying an unbounded patch chain.
- FR-7: Title, description, tags, path, and content changes must be represented distinctly in history so UI and CLI can summarize changes accurately.
- FR-8: A revision may include a light audit link containing audit event/session/source metadata when such metadata is available from the write path.
- FR-9: Missing or rotated audit events must not make a doc history entry invalid or prevent history retrieval, comparison, or restore.
- FR-10: The WebUI doc view must provide a History drawer or panel reachable from the document toolbar.
- FR-11: The History drawer must show a timeline of revisions with version ID, timestamp, actor/source, change summary, affected fields or sections, and checkpoint indicator.
- FR-12: Selecting a revision in WebUI must show a diff view for the selected revision or selected revision compared with current content.
- FR-13: The diff view must support section-level compare, whole-doc compare, copy changed content, restore section, and restore whole doc according to available revision data.
- FR-14: Restore section must update only the selected section and record a new history revision for the restore action.
- FR-15: Restore whole doc must restore the document state represented by the selected revision or checkpoint and record a new history revision for the restore action.
- FR-16: CLI, MCP, and API history reads must expose the new revision metadata and remain suitable for machine-readable use.
- FR-17: Existing history files should be migrated or read compatibly so older doc history is not silently lost.
- FR-18: Retention must be configurable and applied consistently to doc histories without breaking the ability to restore from retained revisions.
- FR-19: Retention must compact or purge old revisions according to policy while preserving enough checkpoints and metadata to keep retained history coherent.
- FR-20: The system must distinguish doc history from MCP audit in product surfaces: doc history explains content changes; audit explains tool activity.

### Non-Functional Requirements

- NFR-1: Doc save/update operations must not fail solely because optional audit metadata cannot be attached.
- NFR-2: History write failures must be visible to logs or caller diagnostics instead of being silently ignored.
- NFR-3: History storage should avoid duplicating full document content for every small edit.
- NFR-4: History reads for common-size docs should remain responsive in CLI, MCP, and WebUI.
- NFR-5: The storage format must be debuggable as project files and compatible with the existing file-based storage philosophy.
- NFR-6: Sensitive content risk must be documented because history can retain content that is later removed from the current doc.

## Acceptance Criteria

- [ ] AC-1: Creating a doc records an initial checkpoint revision with stable doc identity, path, hashes, timestamp, and snapshot data sufficient for restore.
- [ ] AC-2: Updating a single markdown section records a revision whose summary identifies that section and whose diff does not store a full duplicate of the entire document body.
- [ ] AC-3: Updating content where no section can be identified records a valid whole-content diff and marks the affected scope clearly.
- [ ] AC-4: Renaming a doc preserves a single continuous history under stable doc identity and records the path change.
- [ ] AC-5: A doc update from MCP records actor/source metadata and a light audit link when audit context is available.
- [ ] AC-6: A doc update without audit context still records a valid revision and can be retrieved, compared, and restored.
- [ ] AC-7: WebUI doc toolbar exposes a History control that opens a timeline without leaving the current doc context.
- [ ] AC-8: Timeline entries show version ID, timestamp, actor/source, affected field or section, change size summary, and checkpoint badge when applicable.
- [ ] AC-9: Selecting a timeline entry displays a readable diff for the affected section or whole document.
- [ ] AC-10: Restore section updates only the target section and creates a new revision describing the restore.
- [ ] AC-11: Restore whole doc restores the selected historical state and creates a new revision describing the restore.
- [ ] AC-12: Retention policy enforces configured maximum version count and maximum age without corrupting retained history.
- [ ] AC-13: Compacted or purged history remains clear in WebUI and API responses; users can tell when older detail is unavailable.
- [ ] AC-14: CLI and MCP history responses expose structured revision metadata, changed scopes, checkpoint status, and audit-link metadata.
- [ ] AC-15: Existing full-snapshot doc history can still be read or migrated so prior project history is not lost.
- [ ] AC-16: Tests cover create, update, rename, section restore, whole-doc restore, missing audit link, and retention compaction/purge behavior.

## Scenarios

### Scenario 1: Section edit from WebUI

**Given** a doc contains `## Requirements` and `## Technical Notes`
**When** a user edits only `## Requirements` in the WebUI
**Then** the system records a new revision scoped to `## Requirements`
**And** the History drawer shows the affected section and actor/source
**And** selecting the revision shows a section diff.

### Scenario 2: MCP agent update with audit link

**Given** an MCP client updates a doc through `docs.update`
**When** audit context is available for the tool call
**Then** the resulting doc revision includes light audit metadata
**And** WebUI shows the actor/source and a link to inspect the audit event when available.

### Scenario 3: Missing audit event

**Given** a doc revision references an audit event that has been rotated or purged
**When** the user opens history for that doc
**Then** the revision still appears normally
**And** WebUI indicates that the audit event is unavailable without blocking diff or restore actions.

### Scenario 4: Restore section

**Given** a later agent edit changed only `## Acceptance Criteria`
**When** the user selects an earlier revision and chooses restore section
**Then** only `## Acceptance Criteria` is restored
**And** all other sections remain unchanged
**And** the restore creates a new revision.

### Scenario 5: Restore whole doc

**Given** a checkpoint revision exists for a doc
**When** the user chooses restore whole doc from that checkpoint
**Then** the document content and metadata are restored to the selected historical state where applicable
**And** the restore action creates a new revision.

### Scenario 6: Rename preserves history

**Given** a doc has existing history at `specs/foo`
**When** the doc is renamed to `specs/bar`
**Then** the history remains continuous under one stable doc identity
**And** the timeline records the path change.

### Scenario 7: Retention compacts old history

**Given** a doc exceeds configured version-count or age limits
**When** retention runs or a new revision is saved
**Then** old revisions are compacted or purged according to policy
**And** retained checkpoints still allow restore for retained history.

## Technical Notes

- Current code stores doc history in `.knowns/versions/doc-<path>.json` and records full content in `Snapshot`; this spec requires moving toward stable doc identity and bounded hybrid revisions.
- Revision data should keep content diffs and metadata separate from MCP audit events. Audit links are references, not embedded audit logs.
- Section attribution should prefer explicit section updates when available and use markdown structure detection for broader content replacements where feasible.
- Restore operations should be normal doc updates that produce new revisions; history should not be mutated as if time moved backward.
- Retention should not delete the latest checkpoint required to reconstruct retained revisions.
- Existing CLI/MCP/API contracts may need additive fields for compatibility rather than abrupt response shape replacement.

## Task Links

- @task-64xuw3 [doc-history-01] Add stable revision storage model
- @task-vo17h0 [doc-history-02] Record section diffs and audit metadata
- @task-u7vemg [doc-history-03] Implement restore and retention behavior
- @task-hosdj7 [doc-history-04] Expose structured history through CLI, MCP, and API
- @task-zq44iu [doc-history-05] Build WebUI history timeline, diff, and restore flows
- @task-r3jeka [doc-history-06] Add regression tests and sensitive-history docs

## Open Questions

- [ ] What exact default retention values should v1 use for maximum versions per doc and maximum age?
- [ ] Should retention execute only on doc history writes, through an explicit cleanup command, or both?
- [ ] Should restore whole doc include metadata fields such as title, description, tags, and path by default, or content only unless selected?
