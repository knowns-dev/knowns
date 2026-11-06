---
id: doc-6f53d18f111469ea9b2ac7b1ead3d61e
title: 'Learning: 3-Layer Memory System'
description: Patterns, decisions, and failures from implementing the 3-layer memory system
createdAt: '2026-04-02T08:47:52.066Z'
updatedAt: '2026-04-02T09:39:21.130Z'
tags:
  - learning
  - memory
  - architecture
  - full-stack
---

## Patterns

### Multi-Directory Store Pattern
- **What:** A single Store struct managing files across 3 directories (project `.knowns/memory/`, working `.knowns/.working-memory/`, global `~/.knowns/memory/`) with `dirForLayer()` routing and `Get()` searching all dirs in priority order.
- **When to use:** Any entity that needs scoped persistence (session vs project vs user-global).
- **Source:** @doc/specs/3-layer-memory-system

### Promote/Demote as File Move
- **What:** Layer transitions implemented as write-new-then-delete-old (not rename, since dirs may be on different filesystems for global). Layer field updated in frontmatter + search reindex.
- **When to use:** Any entity that moves between storage locations.
- **Source:** @doc/specs/3-layer-memory-system

## Decisions

### Free-form markdown over structured sections
- **Chose:** Free-form content body (like docs)
- **Over:** Structured sections (like tasks with AC/plan/notes)
- **Tag:** GOOD_CALL
- **Outcome:** Simpler chunker, simpler storage, AI agents can structure content however they want. No wasted sections for short entries.
- **Recommendation:** Default to free-form for AI-consumed entities. Structure only when humans need consistent navigation.

### Working memory in both MCP and CLI
- **Chose:** MCP in-memory map + CLI temp files in `.knowns/.working-memory/`
- **Over:** MCP-only (simpler) or skip working layer entirely
- **Tag:** TRADEOFF
- **Outcome:** More code (WorkingMemoryStore + CLI temp file handling), but both humans and agents can use working memory. CLI working memory persists across commands within a session.
- **Recommendation:** If a feature is primarily for AI agents, consider MCP-only first. Adding CLI support doubles the surface area.

### Unified search ranking (no layer boost)
- **Chose:** Memory entries ranked by relevance alongside tasks/docs
- **Over:** Layer-boosted ranking or separate search
- **Tag:** GOOD_CALL
- **Outcome:** Zero additional complexity in search engine. Memory entries compete on content quality, not layer privilege.
- **Recommendation:** Start with unified ranking. Add boosting only if users report memory entries getting buried.

## Failures

### Test signature breakage from validate refactor
- **What went wrong:** Adding `memoryIDs` param to `validateTask()` and `validateDoc()` broke all existing test calls (20+ call sites).
- **Root cause:** Shared internal functions with many callers. Adding a param is a breaking change even for private functions.
- **Time lost:** ~3 minutes fixing test calls.
- **Prevention:** When extending validation to a new entity type, consider passing a `context` struct instead of adding positional params. Or use the `Options` struct that's already there.


### Unified search over separate search_memories tool
- **Chose:** Remove `search_memories` MCP tool, use `search(type: "memory")` instead
- **Over:** Keeping a dedicated `search_memories` tool alongside unified search
- **Tag:** GOOD_CALL
- **Outcome:** One fewer MCP tool to maintain. Unified search already indexes memory entries with semantic search. Agents use one consistent API (`search`) for all entity types.
- **Recommendation:** When adding a new entity type, integrate it into unified search rather than creating a separate search tool.

### Sync always overwrites generated files
- **Chose:** `knowns sync` always overwrites agent instruction files and skills
- **Over:** Requiring `--force` flag to overwrite existing files
- **Tag:** GOOD_CALL
- **Outcome:** Eliminates the most common support issue ("my AGENTS.md is outdated"). Generated files should always match the current CLI version. `--force` flag kept but deprecated.
- **Recommendation:** Generated/templated files should always be overwritten on sync. Only user-authored files need protection.

### Memory guidance in KNOWNS.md over per-skill duplication
- **Chose:** One `## Memory Usage` section in KNOWNS.md with a "capture as it emerges" rule, plus lightweight per-skill hints
- **Over:** Full memory instructions duplicated in every skill
- **Tag:** GOOD_CALL
- **Outcome:** Single source of truth for memory behavior. Skills just add a search call or add_memory call where relevant. No maintenance burden of keeping 13 copies in sync.
- **Recommendation:** For cross-cutting agent behaviors, put the rule in KNOWNS.md and keep skill-level additions minimal.
