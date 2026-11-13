---
id: doc-06afab5e25be66accad21983024e49c8
title: MCP Audit Trail And Tool Stats
description: Draft specification for structured MCP tool-call auditing, recent activity views, and aggregate usage statistics.
createdAt: '2026-04-22T08:51:27.571Z'
updatedAt: '2026-04-23T06:50:10.918Z'
tags:
  - spec
  - approved
  - mcp
  - audit
  - observability
  - security
  - runtime
---

# MCP Audit Trail And Tool Stats

## Overview

Add a structured audit trail for MCP tool invocations in Knowns. Every MCP tool call is recorded as a JSON-lines event in a global log file. Users can inspect recent activity and aggregate stats via CLI commands and the WebUI.

## Locked Decisions

- D1: Audit storage is global at `~/.knowns/audit.jsonl`. Each event contains a `projectRoot` field for per-repo filtering.
- D2: Phase 1 scope = recording all MCP tool calls + CLI `knowns audit recent` / `knowns audit stats` + WebUI activity view. No MCP audit query tool for agents in this phase.
- D3: Size-based file rotation at 5 MB default, keeping up to N backup files. Oldest backup is deleted when limit is exceeded.

## Requirements

### Functional Requirements

- FR-1: Every MCP tool call must produce a structured audit event appended to `~/.knowns/audit.jsonl`.
- FR-2: Each audit event must include: timestamp, toolName, action (sub-action), actionClass, projectRoot, dryRun flag, result status, durationMs, errorMessage (on failure), entityRefs, and argumentSummary.
- FR-3: Audit events must distinguish at least `success`, `error`, and `denied` result outcomes.
- FR-4: Audit events must capture whether a call was a dry-run when the tool supports it.
- FR-5: Action classification must map each tool+action pair to one of: `read`, `write`, `delete`, `generate`, `admin`.
- FR-6: The `audit` tool's own calls must NOT be recorded to avoid recursion (if an audit MCP tool is added later).
- FR-7: `argumentSummary` must be privacy-safe: log keys and short values, summarize large content fields by size, never log secrets.
- FR-8: `entityRefs` must capture lightweight references (task IDs, doc paths, memory IDs, template names) without full content.
- FR-9: CLI command `knowns audit recent` must display the most recent N events (default 50, max 500), newest first.
- FR-10: CLI command `knowns audit stats` must display aggregate statistics: total calls, by tool, by action class, by result, dry-run vs executed counts.
- FR-11: Both CLI commands must support `--project` filter to scope results to a specific repo.
- FR-12: Both CLI commands must support `--plain` and `--json` output formats.
- FR-13: CLI `knowns audit recent` must support `--tool`, `--result`, `--limit` filters.
- FR-14: WebUI must expose an activity view showing recent MCP tool calls with filtering.
- FR-15: WebUI activity view must show per-tool stats summary.

### Non-Functional Requirements

- NFR-1: Audit recording must be async (fire-and-forget goroutine) so it does not slow down MCP tool responses.
- NFR-2: Audit log must be append-only JSON-lines format for integrity and easy parsing.
- NFR-3: File rotation at 5 MB with configurable max backups (default 2). Oldest backup deleted when exceeded.
- NFR-4: Audit recording failures must be logged to stderr but must never cause tool call failures.
- NFR-5: The system must be compatible with future MCP audit query tool and permission events.

## Audit Event Model

```json
{
  "timestamp": "2026-04-23T10:00:00.000Z",
  "toolName": "tasks",
  "action": "create",
  "actionClass": "write",
  "projectRoot": "/Users/dev/my-project",
  "dryRun": false,
  "result": "success",
  "durationMs": 42,
  "errorMessage": "",
  "entityRefs": ["task:abc123"],
  "argumentSummary": {
    "title": "Fix login bug",
    "description": "[128 chars]",
    "priority": "high"
  }
}
```

### Action Classification Map

| Tool | Action | Class |
|------|--------|-------|
| tasks | create, update | write |
| tasks | get, list, history, board | read |
| tasks | delete | delete |
| docs | create, update | write |
| docs | get, list, history | read |
| docs | delete | delete |
| time | start, stop, add | write |
| time | report | read |
| search | search, retrieve, resolve | read |
| code | search, symbols, deps, graph | read |
| templates | create | write |
| templates | get, list | read |
| templates | run | generate |
| validate | * | read |
| memory | add, update, promote, demote | write |
| memory | get, list | read |
| memory | delete | delete |
| project | set | admin |
| project | detect, current, status | read |

### Privacy Rules

- Large content fields (content, description, notes, plan, appendNotes, appendContent) → log `[N chars]` instead of value.
- Entity IDs and paths → log as-is (they are references, not content).
- Short scalar fields (title, status, priority, assignee) → log value directly, truncate at 100 chars.
- Never log secrets or credentials.

## Acceptance Criteria

- [ ] AC-1: Every MCP tool call produces a structured audit event in `~/.knowns/audit.jsonl`.
- [ ] AC-2: Audit events contain all required fields: timestamp, toolName, action, actionClass, projectRoot, dryRun, result, durationMs.
- [ ] AC-3: `knowns audit recent` displays recent events newest-first with `--tool`, `--result`, `--limit`, `--project` filters.
- [ ] AC-4: `knowns audit stats` displays aggregate statistics with `--project` filter.
- [ ] AC-5: Both CLI commands support `--plain` and `--json` output.
- [ ] AC-6: Dry-run calls are distinguishable from real executions in events and stats.
- [ ] AC-7: Large content fields are summarized by size, not logged verbatim.
- [ ] AC-8: File rotation occurs at 5 MB with max backup cleanup.
- [ ] AC-9: Audit recording is async and does not slow down tool responses.
- [ ] AC-10: Audit recording failures do not cause tool call failures.
- [ ] AC-11: WebUI activity view shows recent MCP tool calls with filtering and per-tool stats.

## Scenarios

### Scenario 1: Normal tool call recording
**Given** an MCP client calls `tasks.create` with title "Fix bug"
**When** the tool completes successfully
**Then** an audit event is appended with toolName="tasks", action="create", actionClass="write", result="success", and argumentSummary containing the title.

### Scenario 2: Error recording
**Given** an MCP client calls `docs.get` with a non-existent path
**When** the tool returns an error
**Then** an audit event is appended with result="error" and errorMessage containing the error text.

### Scenario 3: Dry-run recording
**Given** an MCP client calls `tasks.delete` with dryRun=true
**When** the tool completes
**Then** an audit event is appended with dryRun=true and actionClass="delete".

### Scenario 4: Privacy-safe content logging
**Given** an MCP client calls `docs.create` with a 5000-char content body
**When** the event is recorded
**Then** argumentSummary shows `content: "[5000 chars]"` instead of the full body.

### Scenario 5: File rotation
**Given** `~/.knowns/audit.jsonl` exceeds 5 MB
**When** a new event is appended
**Then** the current file is rotated to `audit.jsonl.1`, old backups shift, and the oldest beyond max backups is deleted.

### Scenario 6: CLI recent with project filter
**Given** audit events exist for multiple projects
**When** user runs `knowns audit recent --project /path/to/repo`
**Then** only events with matching projectRoot are shown.

### Scenario 7: CLI stats
**Given** audit events exist
**When** user runs `knowns audit stats`
**Then** output shows total calls, breakdown by tool, by action class, by result, and dry-run vs executed counts.

## Technical Notes

- Use mcp-go `server.Hooks` with `OnBeforeCallTool` / `OnAfterCallTool` for recording.
- Store pending call start times keyed by request ID for duration calculation.
- The audit store lives outside the project Store since it's global — use `~/.knowns/` path directly.
- JSON-lines format (one JSON object per line) for easy append and streaming reads.
- CLI commands go under `cmd/knowns/commands/audit.go`.
- WebUI: new route + React component for activity view.

## Open Questions

- [ ] Exact max backups default — 2 or 3?
- [ ] Should WebUI activity view auto-refresh via SSE or manual refresh?
