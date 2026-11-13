---
id: doc-d985065d0ed63ad8c9ac572eac32bfc6
title: 'Dynamic Initial & Help Registry'
description: Spec for refactoring MCP initial tool output to be dynamic and adding a help registry for on-demand tool documentation
createdAt: '2026-05-20T18:52:03.545Z'
updatedAt: '2026-05-20T18:55:39.287Z'
tags:
  - spec
  - mcp
  - ai
  - approved
---

## Overview

Refactor the MCP `initial` tool to produce dynamic, context-aware output and introduce a `help` tool with a registry pattern that provides on-demand documentation for any tool/action combination.

Currently `initial` returns a static ~80-line instruction block. The new design splits responsibilities:
- `initial` → compact session overview + dynamic state + behavioral overrides + workflow routing
- `help` → deep per-action documentation, queryable on demand

## Locked Decisions

- D1: Help entry structure is flexible — required fields: `When` + `Params`, optional: `Why`, `Examples`, `Flow`. Each tool decides its own detail level.
- D2: Query syntax supports 3 modes — exact match (`code.find`), prefix wildcard (`code.*`), keyword search (`help("insert")` searches all entries containing "insert").
- D3: Dynamic state in `initial` includes: knowledge counts, active timer, LSP warnings, code index status, and workflow guidance (skill routing — when to use which skill).
- D4: Code Intelligence override at FORBIDDEN level in `initial` — agent must not use Read/Grep/Edit for code files except explicitly permitted exceptions.

## Requirements

### Functional Requirements

#### Help Registry

- FR-1: Each `Register*Tool` function can register help entries via `server.RegisterHelp(key, entry)`
- FR-2: Help entries are keyed by `tool.action` format (e.g., `code.find`, `tasks.update`)
- FR-3: Help entry struct has required fields (`When`, `Params`) and optional fields (`Why`, `Examples`, `Flow`)
- FR-4: `help` tool accepts a list of queries as input
- FR-5: Query resolution supports exact match (`code.find`), prefix wildcard (`code.*`), and keyword search (searches When/Params/Why content)
- FR-6: Multiple queries in one call return concatenated results with separators
- FR-7: When no match found, return available keys that are closest (suggest alternatives)

#### Initial Tool Refactor

- FR-8: `initial` output includes dynamic project state: knowledge counts (docs, tasks, templates, memories), active timer info, LSP warnings, code index status
- FR-9: `initial` output includes FORBIDDEN-level Code Intelligence override rules
- FR-10: `initial` output includes workflow guidance — when to use which skill/flow (research small vs large, plan small vs large, etc.)
- FR-11: `initial` output includes a brief tools-available summary with action counts per tool
- FR-12: `initial` output instructs agent to use `help("tool.action")` for detailed usage
- FR-13: Total `initial` output stays under 80 lines regardless of dynamic content

#### Code Tool Extensions (prerequisite)

- FR-14: Add `code(find)` action — search symbols by name pattern with optional body retrieval and depth
- FR-15: Add `code(insert)` action — insert code before/after a symbol anchor
- FR-16: Add `code(delete)` action — safe delete with reference check before removal
- FR-17: Add `code(replace_symbol)` action — replace entire symbol body by name_path

### Non-Functional Requirements

- NFR-1: Help registry adds zero overhead to tool execution (entries stored in memory, no I/O on register)
- NFR-2: `initial` output must be ≤ 80 lines to minimize token consumption
- NFR-3: `help` output for a single action should be ≤ 20 lines
- NFR-4: Keyword search should be case-insensitive and match partial words

## Acceptance Criteria

- [ ] AC-1: Calling `initial` returns dynamic project state (counts, timer, LSP, index status)
- [ ] AC-2: Calling `initial` includes FORBIDDEN code intelligence rules
- [ ] AC-3: Calling `initial` includes workflow guidance for skill routing
- [ ] AC-4: Calling `initial` output is ≤ 80 lines total
- [ ] AC-5: `help("code.find")` returns entry with at least When + Params fields
- [ ] AC-6: `help("code.*")` returns all code action entries
- [ ] AC-7: `help("insert")` keyword search finds entries containing "insert" in any field
- [ ] AC-8: Each Register*Tool registers its own help entries (no central hardcoded list)
- [ ] AC-9: `code(find)` locates symbols by name pattern with include_body and depth support
- [ ] AC-10: `code(insert)` inserts code before/after a symbol anchor
- [ ] AC-11: `code(delete)` checks references before deleting, returns ref list if unsafe
- [ ] AC-12: `code(replace_symbol)` replaces symbol body by name_path
- [ ] AC-13: Adding a new tool with help entries requires only RegisterHelp calls at registration site

## Scenarios

### Scenario 1: Agent Session Start
**Given** a project with 12 docs, 8 tasks, active timer on task-42
**When** agent calls `initial`
**Then** output contains: project name, knowledge counts, active timer info, code intelligence rules, workflow guidance, and help usage hint — all in ≤ 80 lines

### Scenario 2: Agent Needs Code Editing Guidance
**Given** agent needs to insert a new function
**When** agent calls `help("code.insert", "code.find")`
**Then** returns structured entries for both actions with When, Params, and any optional fields registered

### Scenario 3: Agent Keyword Search
**Given** agent is unsure which tool handles "references"
**When** agent calls `help("references")`
**Then** returns all entries where "references" appears in When/Params/Why (e.g., code.references, code.delete)

### Scenario 4: New Tool Registration
**Given** developer adds a new `audit` tool
**When** they call `server.RegisterHelp("audit.log", entry)` in RegisterAuditTool
**Then** `help("audit.*")` returns the entry without any changes to initial or help tool code

### Scenario 5: Code Discovery Override
**Given** agent wants to understand a function
**When** agent considers using Read to open the file
**Then** initial instructions FORBID this — agent must use `code(find, query:"funcName", include_body:true)` instead

## Technical Notes

- Help registry is an in-memory map on the MCP server struct: `map[string]HelpEntry`
- `RegisterHelp` is a method on the server, called during tool registration
- `initial` output is built dynamically each call (not cached) since it includes live state
- Code tool extensions (find, insert, delete, replace_symbol) depend on LSP manager availability — fallback behavior TBD during planning
- Keyword search iterates all entries and matches against concatenated field content

## Open Questions

- [ ] Should `help` support a `verbose` flag to control output detail level?
- [ ] Should `initial` output be cacheable with a TTL, or always rebuilt?
- [ ] For `code(find)` without LSP — fall back to tree-sitter symbols or return error?
- [ ] Should `code(delete)` require explicit confirmation param when refs exist, or just return refs and let agent decide?


## Addendum: Decision D5

- D5: `help` tool returns JSON object structured as `{ tool: { action: { ...fields } } }`. This allows agents to parse programmatically and understand the tool→action hierarchy. Each action object contains the registered help fields (when, params, and optionals). Multiple queries are merged into one object grouped by tool prefix.


## Post-Implementation Updates

After implementation is complete, these files must be updated to reflect the new flow:

### CLAUDE.md
- Remove explicit `project({ action: "status" })` guidance — `initial` now covers this
- Rút gọn tool selection section — point to `initial` + `help` instead of listing everything
- Update workflow section to reflect single `initial` call instead of `initial` + `project(status)`

### Session Start Hook
- Simplify hook message — only remind to call `initial`, remove `project(status)` mention
- Consider removing hook entirely since MCP `WithInstructions` already prompts agent

### KNOWNS.md
- Update `## Tool Selection` section to reference `help` tool for detailed guidance
- Update `## TL;DR` to reflect new session start flow (just `initial`)
- Remove redundant tool orchestration details that are now in `initial` output
