---
id: doc-fed4ae8bc145cf6496cb1997e595d048
title: 'Pattern: Adding a New Entity Type'
description: Step-by-step blueprint for adding a new first-class entity (like memory, notes, etc.) to Knowns across all layers
createdAt: '2026-04-02T08:47:18.339Z'
updatedAt: '2026-04-02T08:47:18.339Z'
tags:
  - pattern
  - architecture
  - entity
  - full-stack
---

## Overview

Blueprint for adding a new first-class entity type to Knowns. Derived from the Memory system implementation which touched all layers in a single pass.

Source: @doc/specs/3-layer-memory-system

## The 8-Layer Checklist

Adding a new entity requires changes across 8 layers, in this order:

### 1. Model (`internal/models/<entity>.go`)
- Define struct with JSON + YAML tags
- `Content` field uses `yaml:"-"` (stored in body, not frontmatter)
- Add helper functions (validation, ID generation, filename)
- Reuse `models.NewTaskID()` for 6-char base36 IDs

### 2. Storage (`internal/storage/<entity>_store.go`)
- Add `<Entity>Store` struct with `root string`
- Implement CRUD: `List`, `Get`, `Create`, `Update`, `Delete`
- Add frontmatter struct (private, mirrors YAML fields)
- Use existing utils: `splitFrontmatter`, `atomicWrite`, `parseISO`, `formatISO`, `yamlScalar`
- Add `<Entity>Store` field to `Store` struct in `store.go`
- Initialize in `NewStore()`
- Add directory to `Init()` dirs list

### 3. Search (`internal/search/`)
- `types.go`: Add `ChunkType<Entity>` constant + entity fields on `Chunk` struct
- `chunker.go`: Add `Chunk<Entity>()` function
- `engine.go`: Add `keywordSearch<Entities>()`, `score<Entity>()`, handle in `scoredChunksToResults`
- `index.go`: Add `Index<Entity>()`, `Remove<Entity>()`, add phase in `Reindex()`
- `sync.go`: Add `BestEffortIndex<Entity>()`, `BestEffortRemove<Entity>()`
- `models/search.go`: Add entity-specific fields to `SearchResult`

### 4. CLI (`internal/cli/<entity>.go`)
- Parent command with shorthand (e.g., `knowns memory <id>` → view)
- Subcommands: create, list, view, edit, delete + entity-specific commands
- Support `--plain`, `--json`, `--no-pager` flags
- Call `search.BestEffortIndex<Entity>()` after mutations
- Register in `init()` with `rootCmd.AddCommand()`

### 5. MCP (`internal/mcp/handlers/<entity>.go`)
- `Register<Entity>Tools(s, getStore)` function
- Tools: add, get, list, search, update, delete + entity-specific
- Follow pattern: nil check → parse args → store op → index → notify → JSON result
- Register in `server.go`

### 6. Validation (`internal/validate/validate.go`)
- Add `@<entity>-<id>` regex
- Build entity ID lookup map in `Run()`
- Add `validate<Entity>()` function
- Check refs in tasks, docs, and the entity itself
- Add entity scope to `Run()` loop

### 7. Graph (`internal/server/routes/graph.go`)
- Add `graph<Entity>RefRE` regex
- Add entity nodes with type, label, data
- Add entity ID lookup map
- Extend `extractMentions()` to detect `@<entity>-<id>` refs
- Scan entity content for outgoing refs

### 8. WebUI
- `api/client.ts`: Add TypeScript interface + API functions
- `router.tsx`: Add route
- `AppShell.tsx`: Add lazy import, getCurrentPage case, renderPage case, title
- `AppSidebar.tsx`: Add sidebar item with icon
- `pages/<Entity>Page.tsx`: List + detail view
- `server/routes/<entity>.go`: REST API endpoints
- `server/routes/router.go`: Register routes

## Key Conventions

- File naming: `<entity>-{id}.md` (e.g., `memory-abc123.md`)
- Frontmatter: private struct, not exported
- Content: markdown body after `---`, accessed via `yaml:"-"` tag
- Timestamps: always `parseISO()` / `formatISO()`
- YAML strings: always `yamlScalar()` for safety
- Tests: update existing test signatures when adding params to shared functions (e.g., `validateTask`)

## Time Estimate

The Memory implementation (6 tasks, full stack) took ~33 minutes total. A simpler entity without multi-directory storage or promote/demote would be faster.
