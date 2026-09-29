---
id: 20260929-0159-knowledge-lives-in-three-tiers-repo-store-hub
title: 'Knowledge lives in three tiers: repo, store, Hub'
status: rejected
supersedes: []
supersededBy: []
tags:
  - knowledge
  - store
  - hub
  - multi-repo
  - architecture
sources:
  - internal/cli/import_cmd.go
  - internal/storage/workspace_store.go
  - internal/storage/mutation_transaction.go (expectedHash)
  - 'knowns-hub: .knowns/docs/specs/2026-08-24/coordination-core-and-delivery.md'
  - 'knowns-studio: SPEC.md sections 6, 9, 12'
relatedDocs:
  - specs/2026-09-09/git-backed-shared-knowledge-store-sync
  - features/import-system
  - features/workspace-system
  - handoffs/hof-2026-08-24-hub-coordination-layer/brief.v2
relatedTasks: []
verification: []
reviewState: ''
reviewBlockers: []
reviewMatches: []
reviewAllowedResolutions: []
reviewEvaluatedHash: 'b53e518087ceb3f6aaab186a60def7acffbd5e36520b1f47f96a0dbf550d96be'
reviewEvaluatedAt: '2026-09-28T18:59:47.546Z'
createdAt: '2026-09-28T18:59:47.546Z'
updatedAt: '2026-09-28T19:03:23.538Z'
---

## Context

A project often spans several repos on one machine (for example shop-web, shop-api, shop-app). Agents in each repo need shared knowledge, and consumers such as Knowns Studio run one flow across those repos. Today the only cross-repo mechanism is knowns import, which fetches only git sources and keeps read-only snapshots (internal/cli/import_cmd.go). .knowns/workspaces.json models agent run sessions, not multi-repo projects (internal/storage/workspace_store.go). knowns-hub coordinates teams across repos and deliberately never mirrors .knowns/docs. Without a stated boundary, the same knowledge can land in any of these places.

## Decision

Knowledge has exactly three homes, chosen by who must agree on it:

1. Repo (.knowns/ in the repo): knowledge about that repo only. Agents read and write freely.
2. Store (git-backed, one per multi-repo project, per the git-backed shared knowledge store spec): shared knowledge for the repos of one project. Agents in any member repo read and write it with expectedHash concurrency; history is git. Refs use a namespace prefix like imports do (@doc/<store>/<path>), resolved repo-first then store.
3. Hub: artifacts a team must agree on, such as contracts, business docs and cross-team handoffs. Agents may draft; only humans publish; audience and ai_access are enforced server-side.

knowns import stays a read-only snapshot mechanism and is not extended into the store. Search and retrieve merge repo and store results and label each result with its scope. Writes default to the repo; writing to the store must be explicit.

## Alternatives Considered

- Extend knowns import into read-write sharing: rejected, import is a one-way snapshot (git-only fetch, deletions not propagated) and would need a second semantics.
- Put shared docs in one of the member repos: rejected, makes repos asymmetric and every repo must know which one owns shared docs.
- Local-only folder (~/.knowns/projects/<p>): rejected as the home, not shareable with a team and lost with the machine.
- Put all shared knowledge on Hub: rejected, Hub requires human publish and a server; day-to-day agent notes should not need either.

## Consequences

- The store spec becomes the path for multi-repo shared docs; its ref namespace reuses the import lookup pattern.
- A store needs its own search index shared by member repos instead of each repo re-indexing it.
- Consumers bind to these tiers: Knowns Studio binds a multi-repo flow to a store (notes and todos default there) and routes cross-repo contracts through Hub instead of defining its own contract model.
- The word workspace is overloaded today (agent run in workspaces.json, project switching under /api/workspaces, multi-repo in Studio); new work should use store for the multi-repo concept.
- Delivery of Hub content into sessions (Hub hooks) and Studio message delivery overlap; ownership must be settled separately.
