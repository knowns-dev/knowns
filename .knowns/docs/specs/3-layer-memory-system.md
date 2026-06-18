---
title: 3-Layer Memory System
description: Specification for Working/Project/Global memory system — persistent knowledge layers for AI agents and users
createdAt: '2026-04-02T07:40:13.536Z'
updatedAt: '2026-06-17T10:34:12.409Z'
tags:
  - spec
  - superseded
  - memory
  - ai
  - historical
---

## Overview

> **⚠️ SUPERSEDED** — Spec lịch sử. Model 3-layer đã giảm xuống 2-layer (project|global) tại commit `adaa9fb` (2026-04-23). Working layer + MCP working-memory handlers bị xóa. D2, D4, D5, D7 + nhiều AC/Scenario ref working layer không còn đúng.
>
> **Replacement (TBD):** `@doc/specs/memory-decision-model`
>
> **Vẫn đúng:** D1 (file format), D3 (unified search), D6 (ID preservation), D8 (ref format), FR-1..FR-8 trừ working, FR-10..FR-16.
>
> **Status:** superseded — effective 2026-06-17. Không implement feature mới theo spec này.

---

A 3-layer memory system that allows AI agents and users to store, retrieve, and promote knowledge across sessions and projects. Memory entries are free-form markdown with metadata, searchable alongside tasks and docs.

**Layers (historical — see banner above):**
- **Working** — ephemeral, session-scoped. Caches active context to avoid re-reading.
- **Project** — persistent, per-project. Patterns, decisions, conventions shared with team.
- **Global** — persistent, cross-project. Personal preferences and reusable knowledge.

## Locked Decisions

- D1: Free-form markdown body + YAML frontmatter (id, title, layer, category, tags, metadata, timestamps). No required sections.
- D2: Working memory available via both MCP and CLI. MCP uses in-memory map (session-scoped). CLI uses temp files in `.knowns/.working-memory/` (cleaned via explicit `knowns memory clean` command).
- D3: Memory entries appear in unified search results ranked by relevance score alongside tasks/docs. No layer boosting, no separate search.
- D4: Dedicated `promote` and `demote` commands for layer transitions (working → project → global and reverse). Handles file moves between directories + search reindex.
- D5: Working memory cleanup is explicit only (`knowns memory clean`), not auto on every command.
- D6: Promote/demote preserves original entry ID.
- D7: Soft limit per layer (configurable, default 100). Warning when exceeded, but creation still allowed.
- D8: Memory ref format `@memory-<id>` (input) → `@.knowns/memory/memory-<id>.md` (output). Follows existing ref system pattern. Memory nodes integrated into GraphPage with distinct visual per layer.
## Requirements

### Functional Requirements

- FR-1: Create memory entries with title, content, layer (working/project/global), category, and tags
- FR-2: List memory entries with filters by layer, category, and tag
- FR-3: View a single memory entry by ID
- FR-4: Edit memory entry fields (title, content, category, tags, append content)
- FR-5: Delete memory entries (with dry-run safety by default in MCP)
- FR-6: Search memory entries via keyword and semantic search, unified with tasks/docs results
- FR-7: Promote memory entries up one layer (working → project → global)
- FR-8: Demote memory entries down one layer (global → project → working)
- FR-9: Working memory cleanup via explicit `knowns memory clean` command (CLI) and auto-cleared on MCP session end (in-memory)
- FR-10: Memory entries indexed in search engine alongside tasks and docs
- FR-11: All operations available via both CLI (`knowns memory ...`) and MCP tools
- FR-12: Soft limit per layer (configurable, default 100) with warning when exceeded
- FR-13: Memory reference format `@memory-<id>` supported in tasks, docs, and other memory entries
- FR-14: Memory entries can contain refs to tasks (`@task-<id>`), docs (`@doc/<path>`), and other memories (`@memory-<id>`)
- FR-15: Memory nodes appear in GraphPage with edges from/to referenced tasks, docs, and memories
- FR-16: Validation checks broken `@memory-<id>` refs in tasks, docs, and memory entries
## Acceptance Criteria

- [ ] AC-1: `knowns memory create "title" --content "..." --layer project` creates a markdown file in `.knowns/memory/`
- [ ] AC-2: `knowns memory create "title" --layer global` creates a markdown file in `~/.knowns/memory/`
- [ ] AC-3: `knowns memory create "title" --layer working` creates a temp file in `.knowns/.working-memory/`
- [ ] AC-4: `knowns memory list --plain` shows all memory entries across all layers
- [ ] AC-5: `knowns memory list --layer project --plain` filters by layer
- [ ] AC-6: `knowns memory view <id> --plain` displays full entry content
- [ ] AC-7: `knowns memory edit <id> --content "new"` updates content
- [ ] AC-8: `knowns memory edit <id> --append "more"` appends to content
- [ ] AC-9: `knowns memory delete <id>` removes the entry file
- [ ] AC-10: `knowns memory promote <id>` moves working→project or project→global (file + reindex, preserves ID)
- [ ] AC-11: `knowns memory demote <id>` moves global→project or project→working (file + reindex, preserves ID)
- [ ] AC-12: `knowns memory promote <id>` on a global entry returns error (already at top)
- [ ] AC-13: `knowns memory demote <id>` on a working entry returns error (already at bottom)
- [ ] AC-14: `knowns search "query" --plain` includes memory entries in results with type "memory"
- [ ] AC-15: `knowns search "query" --type memory --plain` filters to memory entries only
- [ ] AC-16: MCP tool `add_memory` creates entry and indexes it for search
- [ ] AC-17: MCP tool `list_memories` returns entries with layer/category/tag filters
- [ ] AC-18: MCP tool `search_memories` returns search results from memory entries
- [ ] AC-19: MCP tool `promote_memory` and `demote_memory` move entries between layers
- [ ] AC-20: MCP working memory tools (`add_working_memory`, `list_working_memories`, `clear_working_memory`) operate on session-scoped in-memory store
- [ ] AC-21: `knowns memory clean` removes all temp files in `.knowns/.working-memory/`
- [ ] AC-22: `knowns init` creates `.knowns/memory/` directory
- [ ] AC-23: Memory entries are included in `knowns search --reindex`
- [ ] AC-24: `knowns validate` checks memory entries for missing title, invalid layer
- [ ] AC-25: Creating a memory entry when layer count exceeds soft limit (default 100) shows warning but still succeeds
- [ ] AC-26: `@memory-<id>` refs in task/doc/memory content are parsed and resolved (input format: `@memory-<id>`, output format: `@.knowns/memory/memory-<id>.md`)
- [ ] AC-27: `knowns validate` detects broken `@memory-<id>` refs in tasks, docs, and memory entries
- [ ] AC-28: GraphPage shows memory nodes (distinct shape/color per layer) alongside task, doc, and template nodes
- [ ] AC-29: GraphPage renders edges between memory nodes and referenced tasks/docs/memories (and vice versa)
- [ ] AC-30: `GET /api/graph` response includes memory nodes with type "memory" and layer in data field
## Scenarios

### Scenario 1: Agent stores a learned pattern
**Given** an AI agent discovers a coding pattern during implementation
**When** agent calls `add_memory` with layer "project", category "pattern", and the pattern content
**Then** a markdown file is created in `.knowns/memory/`, indexed for search, and retrievable by future sessions

### Scenario 2: Agent uses working memory for session context
**Given** an AI agent starts a new MCP session
**When** agent calls `add_working_memory` with active task context
**Then** the entry is stored in-memory, available via `list_working_memories`, and gone when session ends

### Scenario 3: User promotes knowledge to global
**Given** a project memory entry about a reusable pattern
**When** user runs `knowns memory promote <id>`
**Then** the file moves from `.knowns/memory/` to `~/.knowns/memory/`, layer field updates to "global", search reindexes

### Scenario 4: Promote at top layer
**Given** a memory entry already at "global" layer
**When** user runs `knowns memory promote <id>`
**Then** error returned: "already at top layer, cannot promote"

### Scenario 5: Working memory cleanup
**Given** temp files exist in `.knowns/.working-memory/` from previous sessions
**When** user runs `knowns memory clean`
**Then** all temp files in `.knowns/.working-memory/` are removed

### Scenario 6: Unified search includes memory
**Given** project memory entries exist about "error handling"
**When** user runs `knowns search "error handling" --plain`
**Then** memory entries appear in results alongside matching tasks and docs, ranked by relevance

### Scenario 7: Memory references in content
**Given** a task description contains `@memory-abc123`
**When** user views the task with `--plain`
**Then** the ref is displayed as `@.knowns/memory/memory-abc123.md` and can be followed with `knowns memory abc123 --plain`

### Scenario 8: Memory nodes in GraphPage
**Given** project memory entries exist with refs to tasks and docs
**When** user opens GraphPage in the web UI
**Then** memory nodes appear with distinct shape/color per layer, connected to referenced tasks/docs via edges
## Technical Notes

### Storage Layout
```
.knowns/
├── memory/              # Project memory (git-tracked)
│   └── memory-{id}.md
├── .working-memory/     # Working memory temp (git-ignored)
│   └── memory-{id}.md
└── ...

~/.knowns/
├── memory/              # Global memory (personal)
│   └── memory-{id}.md
└── ...
```

### File Format
```markdown
---
id: abc123
title: Go error handling pattern
layer: project
category: pattern
tags: [go, error-handling]
createdAt: 2026-04-02T10:00:00Z
updatedAt: 2026-04-02T10:00:00Z
---

Wrap errors with context using fmt.Errorf:
Always include the operation name in the wrap message.

Related: @task-42, @doc/conventions, @memory-def456
```

### Reference System
```
Input format:   @memory-<id>
Output format:  @.knowns/memory/memory-<id>.md
Regex:          @memory-([a-z0-9]+)
```

Existing ref regexes to extend:
- @code/internal/server/routes/graph.go — add `graphMemoryRefRE`
- @code/internal/validate/validate.go — add memory ref validation
- @code/internal/storage/store.go — support ref resolution in `--plain` output

### GraphPage Integration
- Node type: `"memory"` with shape distinct from task/doc/template (e.g., circle or star)
- Node color varies by layer: working (gray), project (green), global (purple)
- Data field includes `layer`, `category`, `tags`
- Edges: `"mention"` type for `@memory-<id>` refs (same as existing task/doc mentions)
- Filter toggle: add "memories" checkbox alongside other graph filters in `FilterState`
- Files to modify:
  - @code/internal/server/routes/graph.go — add memory nodes + `@memory-` ref regex
  - @code/ui/src/pages/GraphPage.tsx — add memory node style + filter
  - @code/ui/src/api/client.ts — extend `GraphNode.type` to include `"memory"`

### Integration Points
- Storage: new `MemoryStore` on `Store` coordinator (follows `DocStore` pattern)
- Search: new `ChunkTypeMemory`, `ChunkMemory()`, memory phase in `Reindex()`
- MCP: `RegisterMemoryTools()` + `RegisterWorkingMemoryTools()` in server.go
- CLI: `knowns memory` command group with subcommands
- Validation: memory checks + `@memory-<id>` broken ref detection in `knowns validate`
- Init: `.knowns/memory/` created by `knowns init`
- Refs: `@memory-<id>` parsed in tasks, docs, memory content; resolved in `--plain` output
- Graph: memory nodes + edges in `GET /api/graph` and GraphPage UI
## Open Questions

All resolved:

- [x] Working memory cleanup: explicit command only (`knowns memory clean`), not auto on every command → D5
- [x] Promote/demote preserves original ID → D6
- [x] Soft limit per layer (e.g., 100) with warning when exceeded, but still allows creation → D7
