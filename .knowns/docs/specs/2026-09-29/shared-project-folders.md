---
id: doc-d3accd3df7760f6a87319d0f6accd5f9
title: Shared Project Folders
description: Specification for store folders that several code repositories mount, read and write through namespaced refs
createdAt: '2026-09-28T19:26:20.856Z'
updatedAt: '2026-09-29T04:12:54.863Z'
tags:
  - spec
  - approved
  - store
  - multi-repo
---

## Overview

A project often spans several code repositories on one machine, for example `shop-web`, `shop-api` and `shop-app`. Agents working in each repository need knowledge that all of them can read and write: cross-cutting architecture notes, research that informs more than one repo, and the notes and todos of an orchestration flow that runs across the repos (Knowns Studio).

@doc/specs/2026-09-09/git-backed-shared-knowledge-store-sync gives every code repository its own folder in a store repository, but has no folder several repositories share. This spec adds **shared folders**: folders in a store that more than one code repository mounts, read and write, through namespaced refs.

It implements the "project-shared" tier of @decision/20260929-0203-knowledge-lives-in-three-tiers-repo-project-shared-hub. It depends on the store spec and does not change its Locked Decisions D1 through D17.

Out of scope: team permissions, publishing and contracts (Knowns Hub), read-only mounts, sharing across different stores, and mounting without the store feature.

## Locked Decisions

- D1: Shared folders are specified here as a separate spec that depends on the store spec. The store spec keeps its scope; its "Proposed Extension" section is replaced by a pointer to this spec.
- D2: A code repository mounts shared folders through a `shares` list on its entry in the machine-level `~/.knowns/registry.json`, the same place the store spec maps a repository to its store folder. Nothing is written into the code repository. A CLI command adds and removes mounts; each machine mounts on its own.
- D3: New entities are created in the repository's own folder by default; creating in a shared folder requires naming it as the scope. An existing entity is changed where it lives, located through its ref, with no scope argument. Every mount can read and write; there are no read-only mounts.
- D4: A shared folder has its own `config.json` with the same layout and ownership split as a repository folder (store spec D13), created when the shared folder is created. Entities created in a shared folder use the shared folder's settings, including its task ID prefix.
- D5: Each shared folder has one search index per machine, in its own `.search/` (not synced, per store spec D1). Every mounting repository queries that index and merges the results with its own; shared content is indexed once per machine, not once per mounting repository.

## System Decision Impact

- Impact: draft new
- Decision: @decision/20260929-0203-knowledge-lives-in-three-tiers-repo-project-shared-hub
- Acceptance gate: the decision stays draft until tasks generated from this spec are linked to it and AC-1 through AC-8 are verified.

## Requirements

### Functional Requirements

- FR-1: A command creates a shared folder in a store (for example `knowns store share create <name> --store <store>`), with the same subfolder layout as a repository folder (`docs/`, `tasks/`, `decisions/`, `memory/`, `templates/`) and its own `config.json` (D4). The new folder is synced by the store runtime like any project folder.
- FR-2: Commands add, remove and list mounts for the current repository (for example `knowns store share add|remove|list`), writing only the repository's entry in `~/.knowns/registry.json` (D2). A mount must name a shared folder that exists in the same store as the repository's own folder.
- FR-3: Refs address shared content with the shared folder name as a namespace: `@doc/<shared>/<path>`, and the equivalent form for tasks, decisions and memory. Resolution order is the repository's own folder first, then each mounted shared folder in `shares` order, reusing the lookup order imports use in `DocStore.Get`.
- FR-4: `doc list`, `task list` and other list commands include entities from mounted shared folders and mark each with its source (the shared folder name). A flag limits a listing to one scope.
- FR-5: Create operations on CLI and MCP accept a scope (`--scope <shared>` on the CLI, a `scope` field on MCP). Without a scope the entity is created in the repository's own folder. A scope that is not mounted is rejected with an error naming the mounted shared folders (D3).
- FR-6: Update, delete and other mutations on an existing entity apply where the entity lives, determined from its resolved ref, and use the existing `expectedHash` optimistic concurrency path (D3).
- FR-7: Each shared folder keeps one search index per machine under its own `.search/`, excluded from sync (D5). `search` and `retrieve` in a repository query its own index and the index of every mounted shared folder, merge the results, and label each result with its tier.
- FR-8: Validation (`knowns validate`) resolves refs into mounted shared folders and reports a ref into a shared folder that is not mounted as an error that names the missing mount.
- FR-9: The store runtime syncs shared folders with the same debounce, fetch interval and per-folder conflict pause as project folders (store spec D2, D3, D8). A conflict in a shared folder pauses only that folder.

### Non-Functional Requirements

- NFR-1: No file is written into any code repository by any operation in this spec.
- NFR-2: Ref resolution for a repository with up to 5 mounts adds no network access and no more than 20 ms over resolution without mounts, measured on a warm cache.
- NFR-3: Shared content is indexed once per machine regardless of how many repositories mount it.
- NFR-4: A missing or unreadable shared folder (for example not yet cloned on a fresh machine) degrades to a warning; repository-local commands keep working.

## Acceptance Criteria

- [ ] AC-1: After creating shared folder `shop-shared` and mounting it from `shop-web` and `shop-api`, a doc created from `shop-web` with scope `shop-shared` is returned by `doc list` in `shop-api`, marked as coming from `shop-shared`.
- [ ] AC-2: A doc created from `shop-api` with no scope lands in `shop-api`'s own folder and does not appear in `shop-web`'s listings.
- [ ] AC-3: Creating with a scope that is not mounted fails, creates nothing, and the error lists the mounted shared folders.
- [ ] AC-4: Two updates to the same shared doc from two repositories using the same expected hash result in one success and one stale-hash conflict; no write is lost.
- [ ] AC-5: `search` in either mounting repository returns a matching shared doc labelled with its shared folder, and the shared folder has exactly one index directory on the machine.
- [ ] AC-6: Namespaced refs into `shop-shared` resolve in every mounting repository, and `knowns validate` in a repository that does not mount `shop-shared` reports such a ref as an unmounted-scope error.
- [ ] AC-7: A task created in `shop-shared` uses the task ID prefix from `shop-shared`'s config, not the prefix of the repository that created it.
- [ ] AC-8: No file under any code repository changes after running every command in AC-1 through AC-7 (verified with `git status` in each code repository).

## Scenarios

### Scenario 1: Sharing research across repositories
**Given** `shop-web` and `shop-api` both mount `shop-shared`
**When** an agent in `shop-web` creates the doc `payments/overview` with scope `shop-shared`
**Then** an agent in `shop-api` finds it through `search` and reads it through its namespaced ref

### Scenario 2: Default stays local
**Given** `shop-api` mounts `shop-shared`
**When** an agent creates a doc without a scope
**Then** the doc lands in `shop-api`'s own folder and is not visible from `shop-web`

### Scenario 3: Concurrent edits from two repositories
**Given** agents in `shop-web` and `shop-api` both read the same shared doc
**When** both write an update with the hash they read
**Then** the first write succeeds and the second fails with a stale-hash conflict and rereads

### Scenario 4: Unmounted scope
**Given** `shop-app` does not mount `shop-shared`
**When** an agent in `shop-app` creates a doc with scope `shop-shared`
**Then** the command fails, names the mounted shared folders, and creates nothing

### Scenario 5: Fresh machine
**Given** a developer's registry mounts `shop-shared` but the store has not finished cloning
**When** they run `doc list` in `shop-web`
**Then** repository-local docs are listed and a warning says `shop-shared` is not available yet

### Scenario 6: Conflict in a shared folder
**Given** a Git-level conflict occurs in `shop-shared`
**When** the runtime syncs
**Then** sync pauses for `shop-shared` only, and each repository's own folder keeps syncing

## Technical Notes

- Ref resolution reuses the repo-first, then-namespace lookup that imports already use in `DocStore.Get` (`internal/storage`); imports stay read-only snapshots and are not extended.
- Mutations go through the existing `expectedHash` path in `internal/storage/mutation_transaction.go`; locating the owning folder from a resolved ref is the only new step.
- The registry lives in `internal/registry/registry.go`; `shares` is a new optional field on a project entry.
- Knowns Studio is a known consumer: it stores multi-repo flows and their notes and todos in a shared folder (knowns-studio `SPEC.md` section 9.1).

## Task Generation

- Task Prefix:

## Task Links

Generated tasks will be linked here after `/kn-plan --from @doc/specs/2026-09-29/shared-project-folders` runs.

## Open Questions

- [ ] The store spec's open question about drafts reaching the team within three seconds applies with wider reach here: a shared folder reaches every repository of the project. Accept, or wait for a local-until-released notion in the store spec?
- [ ] Should `retrieve` weight shared results differently from repository results, or rank them together?
- [ ] Does Knowns Hub need to know about shared folders (for example to publish a shared doc), or does publishing stay per repository?
