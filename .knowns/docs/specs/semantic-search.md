---
title: Semantic Search
createdAt: '2026-02-24T02:57:24.464Z'
updatedAt: '2026-02-24T03:09:10.737Z'
description: Specification for semantic search feature with local embedding models
tags:
  - spec
  - approved
  - search
  - ai
---
## Overview

Semantic Search enables searching tasks and docs based on **meaning** rather than just keyword matching. Uses local embedding models to ensure privacy and offline capability.

**Storage Strategy: Hybrid**
- Models: `~/.knowns/models/` (global, shared)
- Index: `.knowns/search-index/` (per-project)

## Requirements

### Functional Requirements

- FR-1: Init wizard asks user whether to enable semantic search
- FR-2: User selects embedding model from recommended list
- FR-3: Auto-download model on first enable
- FR-4: Index all existing tasks and docs
- FR-5: Incremental indexing on create/update task/doc
- FR-6: Hybrid search: semantic + keyword fallback
- FR-7: Rebuild index command: `knowns search --reindex`
- FR-8: Existing projects can enable via `knowns config`

### Non-Functional Requirements

- NFR-1: Model download < 100MB (prefer smaller models)
- NFR-2: Search latency < 50ms for index < 1000 items
- NFR-3: Offline-capable after model downloaded
- NFR-4: Graceful fallback when model missing

## Configuration

### New Config Fields

```json
{
  "search": {
    "semantic": {
      "enabled": true,
      "model": "gte-small",
      "modelPath": "~/.knowns/models/gte-small"
    }
  }
}
```

### Recommended Models

| Model | Dimensions | Size | Max Tokens | Use Case |
|-------|-----------|------|------------|----------|
| `gte-small` | 384 | ~67MB | 512 | **Recommended** - balanced |
| `all-MiniLM-L6-v2` | 384 | ~80MB | 256 | Short text, sentences |
| `gte-base` | 768 | ~220MB | 512 | Higher accuracy |

## Acceptance Criteria

- [x] AC-1: `knowns init` prompts "Enable semantic search?" (y/n)
- [x] AC-2: If yes, display model picker with recommended options
- [x] AC-3: Model auto-downloads to `~/.knowns/models/<model>/`
- [x] AC-4: Index created at `.knowns/search-index/`
- [x] AC-5: `knowns search "query"` returns semantic results
- [x] AC-6: Falls back to keyword search if model missing
- [x] AC-7: `knowns search --reindex` rebuilds entire index
- [x] AC-8: Existing projects enable via `knowns config set search.semantic.enabled true`

## Scenarios

### Scenario 1: Fresh Init with Semantic Search

**Given** user runs `knowns init`
**When** prompted "Enable semantic search?"
**And** user selects "Yes" and chooses model "gte-small"
**Then** 
- Model downloaded to `~/.knowns/models/gte-small/`
- Config updated with `search.semantic.enabled: true`
- Initial index created (empty, will populate on first task/doc)

### Scenario 2: Clone Repo - Model Exists

**Given** user clones repo with `.knowns/config.json` having semantic enabled
**And** model already exists at `~/.knowns/models/gte-small/`
**When** user runs `knowns search "auth"`
**Then** search works normally (rebuild index if missing)

### Scenario 3: Clone Repo - Model Missing

**Given** user clones repo with semantic enabled in config
**And** model NOT exists at `~/.knowns/models/`
**When** user runs `knowns search "auth"`
**Then**
- Warning: "Semantic search enabled but model missing"
- Prompt: "Download model now? (y/n)" or fallback to keyword
- If decline: fallback to keyword search with note

### Scenario 4: Index Missing (gitignored)

**Given** `.knowns/search-index/` is gitignored
**And** user clones repo
**When** user runs first search
**Then**
- Auto-rebuild index from existing tasks/docs
- Show progress: "Building search index... (45 items)"

### Scenario 5: Enable on Existing Project

**Given** existing project without semantic search
**When** user runs `knowns config set search.semantic.enabled true`
**Then**
- Prompt model selection if not configured
- Download model if missing
- Auto-run `--reindex`

### Scenario 6: Incremental Index Update

**Given** semantic search enabled and index exists
**When** user creates/updates task or doc
**Then** embedding generated and added to index (no full rebuild)

### Scenario 7: Search with Hybrid Mode

**Given** semantic search enabled
**When** user searches "authentication login"
**Then**
- Semantic search finds: "user auth", "sign in flow"
- Keyword search finds: exact matches
- Results merged with weighted scoring

## File Structure

```
~/.knowns/
└── models/
    └── gte-small/
        ├── config.json
        ├── tokenizer.json
        └── model.onnx

project/.knowns/
├── config.json              # search.semantic config
├── tasks/
├── docs/
└── search-index/            # gitignore optional
    ├── embeddings.bin       # Vector data (binary)
    ├── index.json           # Metadata, item IDs
    └── version.json         # Model version, rebuild trigger
```

## Technical Notes

### Library Choice

**Recommended: Orama + Transformers.js**

```typescript
// Embedding generation
import { pipeline } from '@xenova/transformers'
const embedder = await pipeline('feature-extraction', 'Xenova/gte-small')

// Vector storage + search  
import { create, insert, search } from '@orama/orama'
```

### Chunking Strategy

To preserve semantic meaning, content is chunked by logical sections rather than fixed character limits.

#### Document Chunking (by Headings)

```markdown
# Document Title          → Chunk 0: title + description (metadata)
## Overview               → Chunk 1: Overview section
## Installation           → Chunk 2: Installation section  
## API Reference          → Chunk 3: API Reference section
### GET /users            → Chunk 3.1: Nested under parent
### POST /users           → Chunk 3.2: Nested under parent
```

**Rules:**
- Each `##` heading = new chunk
- `###` subheadings = include in parent chunk OR separate (if > 512 tokens)
- Chunk includes heading text for context
- Max chunk size: 512 tokens (model limit for gte-small)

**Chunk Structure:**
```typescript
interface DocChunk {
  id: string              // "doc:<path>:chunk:<index>"
  docPath: string         // "guides/setup"
  section: string         // "## Installation"
  content: string         // Section content
  embedding: number[]     // Vector [384]
  metadata: {
    headingLevel: number  // 2 for ##, 3 for ###
    parentSection?: string
    position: number      // Order in document
  }
}
```

#### Task Chunking (by Fields)

Tasks are chunked by semantic fields, not arbitrary splits:

```typescript
// Task fields → Chunks
{
  title + description    → Chunk 0: "What & Why"
  acceptanceCriteria     → Chunk 1: "Success criteria" (if exists)
  implementationPlan     → Chunk 2: "How to do" (if exists)
  implementationNotes    → Chunk 3: "What was done" (if exists)
}
```

**Rules:**
- Title + Description always combined (context)
- Each optional field = separate chunk (only if not empty)
- Small tasks may have only 1-2 chunks
- Completed tasks have more chunks (notes, plan)

**Chunk Structure:**
```typescript
interface TaskChunk {
  id: string              // "task:<id>:chunk:<field>"
  taskId: string          // "42"
  field: string           // "description" | "ac" | "plan" | "notes"
  content: string         // Field content
  embedding: number[]     // Vector [384]
  metadata: {
    status: string
    priority: string
    labels: string[]
  }
}
```

#### Chunking Benefits

| Approach | Problem | Our Solution |
|----------|---------|--------------|
| Fixed 500 chars | Cuts mid-sentence | Chunk by heading/field |
| Whole document | Exceeds token limit | Section-based chunks |
| No context | Loses meaning | Include heading in chunk |

#### Search Result Mapping

```typescript
// Search returns chunks, map back to source
SearchResult {
  chunk: DocChunk | TaskChunk
  score: number
  source: {
    type: "doc" | "task"
    path: string          // doc path or task id
    section?: string      // which section matched
  }
}
```

### Index Version Control

`search-index/version.json`:
```json
{
  "model": "gte-small",
  "modelVersion": "1.0.0",
  "indexedAt": "2025-02-24T...",
  "itemCount": 145,
  "chunkCount": 523
}
```

If model version changes → auto rebuild index.

### Gitignore Recommendation

```gitignore
# Optional - rebuild on clone
.knowns/search-index/
```
# Optional - rebuild on clone
.knowns/search-index/
```

## CLI Commands

```bash
# Init with semantic search
knowns init
# → "Enable semantic search?" [y/n]
# → "Select model:" [gte-small, all-MiniLM-L6-v2, gte-base]

# Search (auto-detect mode)
knowns search "query"

# Force keyword only
knowns search "query" --keyword

# Rebuild index
knowns search --reindex

# Check status
knowns search --status
# → Semantic: enabled (gte-small)
# → Index: 145 items, last updated 2h ago
# → Model: ~/.knowns/models/gte-small (67MB)

# Enable on existing project
knowns config set search.semantic.enabled true
knowns config set search.semantic.model gte-small
```

## MCP Tools Updates

```typescript
// New tool
mcp__knowns__reindex_search({})

// Updated search with mode
mcp__knowns__search({
  query: "auth",
  mode: "hybrid" | "semantic" | "keyword"  // default: hybrid
})
```

## Open Questions

- [ ] Q1: Should we support custom model path (outside ~/.knowns/models)?
- [ ] Q2: Need "search score threshold" to filter low-confidence results?
- [ ] Q3: Support embedding for acceptance criteria and implementation notes?
- [ ] Q4: Rate limit for incremental indexing (batch updates)?
