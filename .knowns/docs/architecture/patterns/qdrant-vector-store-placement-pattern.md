---
title: Qdrant Vector Store Placement Pattern
description: Architecture pattern for managed Qdrant runtime placement, collection UUID ownership, project metadata pointers, and default semantic vector backend behavior.
createdAt: '2026-08-13T06:54:52.545Z'
updatedAt: '2026-08-13T06:54:52.545Z'
tags:
  - architecture
  - pattern
  - qdrant
  - semantic
  - search
  - runtime
---

# Qdrant Vector Store Placement Pattern

## Purpose

This document defines where managed Qdrant runtime data, vector collections, embedding values, and project pointers should live when Qdrant is used as the default Knowns semantic vector backend.

The key rule is simple:

```text
Qdrant runtime, data, collections, and embeddings live under ~/.knowns.
Project .knowns stores only lightweight metadata pointers to its owned collection UUIDs.
```

This keeps derived vector data out of repositories while preserving project isolation and rebuildability.

## Canonical Placement

### Global machine-owned placement

Managed Qdrant runtime state belongs under the machine-level Knowns root:

```text
~/.knowns/runtime/qdrant/
  bin/                 # managed qdrant binary, if installed by Knowns
  data/                # Qdrant storage, vectors, collections, payload indexes
  logs/                # Qdrant runtime logs
  status.json          # managed runtime status
  qdrant.pid           # process metadata when applicable
```

Qdrant collections and embedding values must be stored in Qdrant data under this runtime root, not in a project repository.

### Project-owned pointer placement

Each project stores only a pointer and readiness metadata:

```text
project/.knowns/.search/qdrant.json
project/.knowns/.search/qdrant-generations.jsonl
```

The pointer file records the active collection UUID, collection name, embedding identity, schema version, chunk version, and owner fingerprint. It does not store vectors.

## Collection Identity

Collections should use a generated UUID as the stable identity. The UUID is the ownership key. Project paths or path hashes are not the primary collection identity.

Recommended collection name:

```text
kn_<uuid-without-dashes>
```

Example:

```text
kn_8f2c6a7b91d44f6ab9f72ef84d72a9c1
```

Benefits of UUID identity:

- Does not leak local project paths.
- Survives project rename or move when the owner fingerprint still matches.
- Avoids collection name collisions.
- Makes orphan cleanup and generation swaps explicit.

## Project Metadata Pointer

Example `project/.knowns/.search/qdrant.json`:

```json
{
  "backend": "qdrant",
  "collectionUUID": "8f2c6a7b-91d4-4f6a-b9f7-2ef84d72a9c1",
  "collectionName": "kn_8f2c6a7b91d44f6ab9f72ef84d72a9c1",
  "schemaVersion": 1,
  "chunkVersion": 5,
  "embedding": {
    "provider": "ollama",
    "model": "qwen3-embedding:0.6b",
    "dimensions": 1024,
    "distance": "cosine"
  },
  "owner": {
    "projectId": "knowns-go",
    "storeRootFingerprint": "sha256:..."
  },
  "lastIndexedAt": null,
  "chunkCount": 0
}
```

If the owner fingerprint does not match the active project store, Knowns should treat the pointer as stale and create a new collection UUID rather than writing into a possibly shared collection.

## Payload Policy

Default Qdrant payloads should be pointer-oriented and avoid full raw content unless a future performance mode explicitly enables it.

Recommended default payload fields:

```json
{
  "chunk_id": "doc:guides/api:3",
  "source_id": "doc:guides/api",
  "type": "doc",
  "doc_path": "guides/api",
  "section": "Authentication",
  "header_path": "API/Authentication",
  "task_id": "",
  "memory_id": "",
  "decision_id": "",
  "status": "",
  "priority": "",
  "labels": ["api"],
  "token_count": 240,
  "content_hash": "sha256:..."
}
```

Search results should map Qdrant points back to canonical Knowns files for snippets and context assembly. This keeps canonical content in docs, tasks, memories, and decisions rather than duplicating it inside Qdrant payloads.

## Store Isolation

Project semantic collections and global memory semantic collections must remain physically separate.

Recommended collection scopes:

```text
project store collection: one active collection per project/store/model generation
global memory collection: one active collection under the global semantic store
```

Memory retrieval should query project and global stores independently, then merge results at the Knowns search or retrieval layer. Raw vectors from different stores should not be directly combined.

## Generation And Reindex Lifecycle

Reindex should use collection generation swap instead of in-place destructive rebuilds.

Recommended flow:

1. Read the active project pointer.
2. Create a new collection UUID for the next generation.
3. Embed and upsert all chunks into the new collection.
4. Verify model, dimensions, chunk version, and chunk count.
5. Atomically swap `qdrant.json` to point at the new collection.
6. Append generation metadata to `qdrant-generations.jsonl`.
7. Retain the previous collection briefly for rollback.
8. Cleanup older orphaned collections asynchronously.

This avoids losing the active semantic index when reindex fails midway.

## New Install Default Behavior

For new projects, Qdrant can be the default vector backend only if Knowns manages the runtime lifecycle automatically.

Required onboarding behavior:

- Ensure the managed Qdrant binary or runtime is available.
- Start Qdrant when semantic vector operations require it.
- Create the project collection UUID and pointer metadata.
- Detect or prepare an embedding provider.
- Queue or run an initial semantic reindex.
- Keep keyword search usable even when semantic readiness is degraded.

If embedding setup is unavailable, Knowns should still initialize the project and Qdrant pointer, then report semantic readiness as degraded with a clear remediation command.

## Migration And Fallback

Existing SQLite vector indexes are derived data and do not require byte-for-byte migration. The safe migration path is to rebuild into Qdrant:

```text
existing project with SQLite index -> create Qdrant collection UUID -> reindex canonical sources -> swap semantic backend metadata
```

Hybrid search must fall back to keyword results when Qdrant or the embedding provider is unavailable. Semantic-only mode should fail clearly with status and log guidance.

SQLite may remain as a temporary compatibility backend during migration, but it should not be the default for new projects once managed Qdrant is ready.

## Out Of Scope

This pattern does not define:

- History storage optimization.
- General `.knowns` directory taxonomy cleanup.
- Team server authorization or multi-user Qdrant hosting.
- Raw history indexing into Qdrant.

Those topics should be handled by separate specs or supporting docs.

## Related Docs

- @doc/specs/2026-07-08/project-semantic-embedding-runtime
- @doc/specs/semantic-search
- @doc/specs/multi-store-semantic-memory-retrieval
- @doc/architecture/patterns/storage
