---
id: 20260929-0203-knowledge-lives-in-three-tiers-repo-project-shared-hub
title: 'Knowledge lives in three tiers: repo, project-shared, Hub'
status: draft
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
  - 'knowns-studio: SPEC.md section 9.1'
relatedDocs:
  - specs/2026-09-09/git-backed-shared-knowledge-store-sync
  - features/import-system
  - features/workspace-system
  - handoffs/hof-2026-08-24-hub-coordination-layer/brief.v2
  - specs/2026-09-29/shared-project-folders
relatedTasks: []
verification: []
reviewState: needs_evidence
reviewBlockers:
  - 'decision "20260929-0203-knowledge-lives-in-three-tiers-repo-project-shared-hub" needs at least one linked task or a spec with linked tasks before acceptance'
reviewMatches: []
reviewAllowedResolutions: []
reviewEvaluatedHash: 'c61c35391cb1d61d93d29e1dfa61bc1731762718ca3e33d599ec55a26520d4fa'
reviewEvaluatedAt: '2026-09-28T19:26:31.222Z'
createdAt: '2026-09-28T19:03:42.480Z'
updatedAt: '2026-09-28T19:26:31.223Z'
---

## Context

A project often spans several repos on one machine (for example shop-web, shop-api, shop-app), and agents in each repo need knowledge the others can read and write. Consumers such as Knowns Studio run one flow across those repos. The existing pieces do not cover this: knowns import is a read-only snapshot that only fetches git sources (internal/cli/import_cmd.go); .knowns/workspaces.json models agent run sessions, not multi-repo projects (internal/storage/workspace_store.go); the git-backed store spec moves each code repo's .knowns into its own folder of a store repo but has no folder several repos share; knowns-hub coordinates teams and deliberately never mirrors .knowns/docs. Without a stated boundary, the same knowledge can land in any of these places.

## Decision

Knowledge has exactly three homes, chosen by who must be able to change it:

1. Repo: knowledge about one code repo. Stored in that repo's .knowns/, or in that repo's folder of a store when the store spec is in use. Agents read and write freely.
2. Project-shared: knowledge several repos of one project read and write, such as cross-cutting architecture notes or research. Stored in a shared folder of the git-backed store that more than one code repo maps to. Writes use expectedHash; history is git. Refs carry the shared folder name as a namespace (@doc/<shared>/<path>) and resolve repo-first, reusing the import lookup order. Writes default to the repo tier; writing to the shared tier is explicit.
3. Hub: artifacts a team must agree on, such as contracts, business docs and cross-team handoffs. Agents may draft; only humans publish; audience and ai_access are enforced server-side.

knowns import stays a read-only snapshot mechanism and is not extended into the shared tier.

## Alternatives Considered

- Extend knowns import into read-write sharing: rejected, import is a one-way snapshot (git-only fetch, deletions not propagated) and would need a second semantics.
- Put shared docs in one of the member code repos: rejected, makes repos asymmetric and every repo must know which one owns shared docs.
- Local-only folder (~/.knowns/projects/<p>): rejected as the home, not shareable with a team and lost with the machine.
- Put all shared knowledge on Hub: rejected, Hub requires human publish and a server; day-to-day agent notes should need neither.

## Consequences

- The git-backed store spec needs an extension: a shared folder in the store, and a registry mapping that lets one code repo map to its own folder plus one or more shared folders. This is not in the store spec today and is proposed there as an extension.
- search and retrieve merge repo and shared results and label each result with its tier; the shared folder keeps one search index used by all member repos.
- Consumers bind to these tiers: Knowns Studio stores multi-repo flows and their notes and todos in the shared tier, and routes cross-repo contracts through Hub instead of defining its own contract model.
- The word workspace is overloaded today (agent run in workspaces.json, project switching under /api/workspaces); new work should not use it for the multi-repo concept.
- Delivery of Hub content into sessions (Hub hooks) and Studio message delivery overlap; ownership must be settled separately.
- Supersedes nothing; replaces the rejected draft 20260929-0159-knowledge-lives-in-three-tiers-repo-store-hub, which described the store as shared across repos.
