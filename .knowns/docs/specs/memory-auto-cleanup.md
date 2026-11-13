---
id: doc-2459918a522ea56c8818e3cb6983b84a
title: Memory Auto-Cleanup
description: Specification for agent-triggered memory cleanup via MCP — list stale candidates for AI review and deletion
createdAt: '2026-05-20T07:09:09.943Z'
updatedAt: '2026-05-20T07:10:22.386Z'
tags:
  - spec
  - approved
  - memory
  - cleanup
  - mcp
---

## Overview

Add a `memory({ action: "cleanup" })` MCP action that returns stale memory candidates for agent review. The agent reads candidates, decides keep or delete for each, and uses existing `memory update` (touch) or `memory delete` actions to act. No LLM logic lives in Go — the intelligence boundary stays in the agent.

## Locked Decisions

- D1: Agent-triggered via MCP. Go returns candidates; agent decides keep/delete.
- D2: Staleness based on `updatedAt` (fallback to `createdAt` if never updated).
- D3: Agent reviews externally using existing MCP tools. No LLM client in Go.
- D4: Keep = agent calls `memory update` which touches `updatedAt`, pushing memory out of the cleanup window automatically.

## Requirements

### Functional Requirements

- FR-1: New MCP action `cleanup` on the `memory` tool that lists stale memory candidates.
- FR-2: Candidates are memories where `updatedAt` (or `createdAt` if `updatedAt` is zero) is older than `olderThanDays` parameter.
- FR-3: `olderThanDays` parameter defaults to 7 if not provided.
- FR-4: Optional `layer` parameter to scope cleanup to `project` or `global`. Defaults to `project`.
- FR-5: Optional `limit` parameter to cap the number of candidates returned. Defaults to 20.
- FR-6: Response includes full content of each candidate (id, title, layer, category, tags, content, createdAt, updatedAt, age in days).
- FR-7: Action is non-destructive — it only lists, never deletes. Agent uses existing `memory delete` to remove.
- FR-8: When agent decides to keep a memory, it calls `memory update` (even with no content change) which touches `updatedAt`, resetting the staleness clock.

### Non-Functional Requirements

- NFR-1: Cleanup listing must complete in < 200ms for up to 200 memories.
- NFR-2: No new dependencies required — uses existing storage and model code.
- NFR-3: No file format migration — leverages existing `createdAt`/`updatedAt` fields.

## Acceptance Criteria

- [ ] AC-1: `memory({ action: "cleanup" })` returns memories older than 7 days by default.
- [ ] AC-2: `memory({ action: "cleanup", olderThanDays: 14 })` respects custom threshold.
- [ ] AC-3: `memory({ action: "cleanup", layer: "global" })` scopes to global memories only.
- [ ] AC-4: `memory({ action: "cleanup", limit: 5 })` returns at most 5 candidates.
- [ ] AC-5: Response includes `id`, `title`, `layer`, `category`, `tags`, `content`, `createdAt`, `updatedAt`, and computed `ageDays` for each candidate.
- [ ] AC-6: Calling `memory({ action: "update", id: "<id>" })` with no content change still updates `updatedAt`.
- [ ] AC-7: After touching `updatedAt`, the memory no longer appears in cleanup results for the configured threshold period.
- [ ] AC-8: CLI `knowns memory cleanup --plain` outputs the same candidates in plain text format.

## Scenarios

### Scenario 1: Happy Path — Agent cleanup session

**Given** 10 project memories, 6 of which have `updatedAt` older than 7 days
**When** agent calls `memory({ action: "cleanup" })`
**Then** response contains those 6 memories with full content and `ageDays` field

### Scenario 2: Agent keeps a memory

**Given** agent receives candidate with id "abc123"
**When** agent calls `memory({ action: "update", id: "abc123" })` with no content changes
**Then** `updatedAt` is refreshed to now, and next cleanup call does not include "abc123"

### Scenario 3: Agent deletes a noisy memory

**Given** agent receives candidate with id "xyz789" containing raw terminal output
**When** agent calls `memory({ action: "delete", id: "xyz789", dryRun: false })`
**Then** memory is removed from storage and search index

### Scenario 4: Custom threshold

**Given** memories with various ages
**When** agent calls `memory({ action: "cleanup", olderThanDays: 30 })`
**Then** only memories stale for 30+ days are returned

### Scenario 5: Empty result

**Given** all memories have been updated within the last 7 days
**When** agent calls `memory({ action: "cleanup" })`
**Then** response is an empty list with a message "No stale memories found"

### Scenario 6: Limit applied

**Given** 15 stale memories exist
**When** agent calls `memory({ action: "cleanup", limit: 5 })`
**Then** only the 5 oldest memories are returned (sorted by staleness descending)

## Technical Notes

- Extend `RegisterMemoryTool` enum to include `"cleanup"` action.
- Add `handleMemoryCleanup` handler in `internal/mcp/handlers/memory.go`.
- Use existing `ListPersistent(layer)` then filter in-memory by age.
- Sort candidates by staleness (oldest first) before applying limit.
- For AC-6, ensure `memory update` with empty/unchanged fields still bumps `updatedAt` — verify current behavior in `storage/memory_store.go`.
- CLI command: add `cleanup` subcommand to `knowns memory` with `--older-than` (days), `--layer`, `--limit`, `--plain`, `--json` flags.

## Open Questions

- [ ] Should there be a `memory({ action: "touch", id: "..." })` convenience action, or is bare `update` sufficient?
- [ ] Should cleanup results include a heuristic quality hint (e.g. title uniqueness score, content length) to help agent decide faster?
