---
id: 20260929-1112-project-knowledge-may-live-outside-the-project-directory
title: Project knowledge may live outside the project directory
status: draft
supersedes: []
supersededBy: []
tags:
  - store
  - storage
  - architecture
sources:
  - internal/storage (Store.Root)
  - internal/registry/registry.go (Registry.Add)
  - internal/safepath/path.go
relatedDocs:
  - specs/2026-09-09/git-backed-shared-knowledge-store-sync
relatedTasks:
  - GST-W7ZY37
  - GST-3XGQ4Q
  - GST-MXJ2TS
verification: []
reviewState: ready_for_review
reviewBlockers: []
reviewMatches: []
reviewAllowedResolutions:
  - accept_new
  - reject_new
reviewEvaluatedHash: 'c0b20f0ba7d74b94049d109a62f87d5393e9e5955214dec4efa8f342ed6ec94e'
reviewEvaluatedAt: '2026-09-29T07:52:18.144Z'
createdAt: '2026-09-29T04:12:26.602Z'
updatedAt: '2026-09-29T07:52:18.144Z'
---

## Context

The git-backed store spec moves a project's .knowns/ out of the code repository into a store clone under ~/.knowns/stores/<store>/<project>/. Today 22 non-test call sites derive the code root as filepath.Dir(store.Root), which is only true while knowledge lives inside the project directory.

## Decision

A project's knowledge root and its code root are independent values. Store carries Root (where knowledge lives) and ProjectRoot (where code lives); no code path derives one from the other. A project is valid when it has a local .knowns/ with a config, or a registry store mapping that resolves to an initialized store directory.

## Alternatives Considered

- Keep .knowns/ in the repo and sync it separately: rejected, it couples knowledge to code review and branches, which is what the store removes.
- A pointer file in the code repo: rejected by store spec D5, the code repository receives zero Knowns files.

## Consequences

- Every filepath.Dir(...Root) derivation is replaced by ProjectRoot; AC-11 of the store spec asserts none remain.
- Code intelligence, LSP, templates, sync and validation resolve code paths from ProjectRoot only (AC-7).
- Registry.Add accepts store-mapped projects without a local .knowns/ (store spec D12).
- safepath must treat a store outside the project directory as a legitimate root.
