---
title: MCP Mutation Response Compaction
description: Specification for token-efficient success responses from MCP task and document create/update actions.
createdAt: '2026-07-24T10:06:24.162Z'
updatedAt: '2026-07-24T10:27:34.372Z'
tags:
  - spec
  - approved
  - mcp
  - token-optimization
---

## Overview

Reduce MCP context usage by replacing full-entity success responses with compact summaries for task and document create/update actions. Callers can explicitly request the exact legacy full payload when they need to inspect the complete entity.

This spec intentionally changes the default success-response behavior for four MCP actions while preserving mutation semantics, error details, and an explicit compatibility path. It narrows the earlier backward-response requirement in @doc/specs/mcp-tool-consolidation-spec only for the actions listed here.

## Locked Decisions

- D1: Change the default immediately to `summary`; callers use `return: full` for the legacy payload.
- D2: Summary responses include entity identity, important final state, and `updatedAt`; a renamed document also includes `previousPath`.
- D3: Support only `summary` and `full`; do not add a `none` mode.
- D4: Apply the contract to `tasks.create`, `tasks.update`, `docs.create`, and `docs.update`.
- D5: Leave delete, archive, unarchive, restore, and batch lifecycle responses unchanged.
- D6: Every form of `docs.update`, including section replacement, append, metadata update, content clearing, and rename, defaults to summary.
- D7: Reject an invalid `return` value with an MCP error that lists `summary` and `full` as valid values.
- D8: `return: full` preserves the existing legacy task or document JSON payload without a new wrapper.
- D9: Preserve current error response details; compact only successful mutation responses.

## Requirements

### Functional Requirements

- FR-1: The consolidated `tasks` MCP tool shall accept an optional `return` argument for `create` and `update`, with allowed values `summary` and `full`.
- FR-2: The consolidated `docs` MCP tool shall accept the same optional `return` argument for `create` and `update`.
- FR-3: Omitting `return` shall behave as `return: summary` for the four in-scope actions.
- FR-4: A successful task summary shall contain exactly the compact contract fields `success`, `taskId`, `status`, and `updatedAt`.
- FR-5: A successful document summary shall contain `success`, `path`, and `updatedAt`; a successful rename shall also contain `previousPath`.
- FR-6: A successful `return: full` call shall return the same entity-shaped JSON payload returned before this feature.
- FR-7: Invalid `return` values shall produce an MCP error result with the valid values stated in the error message.
- FR-8: Existing mutation behavior shall remain unchanged, including persistence, task lifecycle handling, document revision history, reference rewriting, indexing, and notifications.
- FR-9: Existing failure responses and all out-of-scope action responses shall remain unchanged.
- FR-10: MCP tool descriptions, parameter schemas, on-demand help where available, and relevant user/developer documentation shall describe the new default and the `full` opt-in.

### Non-Functional Requirements

- NFR-1: Summary responses must not include task descriptions, plans, notes, acceptance criteria, document content, or other unlisted entity fields.
- NFR-2: Response mode selection must not add storage reads or writes beyond those already required by the mutation.
- NFR-3: The contract must be deterministic across create and update within each domain.
- NFR-4: Targeted automated tests must protect the summary default, legacy full opt-in, invalid mode handling, persisted mutation behavior, and document rename metadata.

## Acceptance Criteria

- [x] AC-1: Calling `tasks.create` or `tasks.update` without `return` succeeds and returns only `success`, `taskId`, `status`, and `updatedAt`.
- [x] AC-2: Calling `docs.create` or any form of `docs.update` without `return` succeeds without returning document content and returns the documented summary fields.
- [x] AC-3: Renaming a document in summary mode returns the new `path` and the old `previousPath`.
- [x] AC-4: Calling any in-scope action with `return: full` returns the legacy entity-shaped payload and persisted data matches the requested mutation.
- [x] AC-5: Calling any in-scope action with an unsupported `return` value returns an MCP error naming `summary` and `full`.
- [x] AC-6: Mutation failures retain their existing error detail and do not get converted into a compact success envelope.
- [x] AC-7: Delete, archive, unarchive, restore, batch lifecycle, get, list, history, and diff response contracts are unchanged.
- [x] AC-8: Tool schema/help and relevant MCP documentation state that `summary` is the default and `full` is the compatibility opt-in.
- [x] AC-9: Automated tests cover all four in-scope actions, both response modes, invalid mode handling, document rename, and persistence side effects.

## Scenarios

### Scenario 1: Default task update

**Given** an existing task with a long description, plan, notes, and acceptance criteria
**When** a caller invokes `tasks.update` without `return`
**Then** the mutation is persisted and the success response contains only the task summary fields

### Scenario 2: Default document section update

**Given** a large document
**When** a caller replaces one section through `docs.update` without `return`
**Then** the revision and index are updated while the success response omits the full document content

### Scenario 3: Explicit legacy payload

**Given** a caller that needs the complete updated entity
**When** it invokes an in-scope action with `return: full`
**Then** it receives the legacy entity-shaped JSON payload without a wrapper

### Scenario 4: Document rename

**Given** an existing document referenced by other entities
**When** a caller renames it through `docs.update` in summary mode
**Then** references are rewritten as before and the response identifies both the new path and `previousPath`

### Scenario 5: Invalid response mode

**Given** a caller passes `return: compact`
**When** an in-scope action validates its arguments
**Then** it returns an MCP error listing `summary` and `full`, and no mutation occurs

### Scenario 6: Mutation failure

**Given** a mutation that fails storage or lifecycle validation
**When** the handler returns the failure
**Then** the existing detailed error response is preserved

## Technical Notes

- Current task and document create/update handlers serialize the complete entity after a successful mutation.
- Validation of `return` must happen before mutation so an invalid mode cannot change state.
- Summary types should be explicit rather than derived by stripping fields from full entities.
- `return: full` is the migration path for callers that currently parse complete task or document payloads.
- Other mutation domains such as memory and decision require separate measurement and contract review before inclusion.

## Task Links

- @task-9uus0j [mcp-mutation-response-compaction-01] Implement compact mutation responses (done)

## Open Questions

None.
