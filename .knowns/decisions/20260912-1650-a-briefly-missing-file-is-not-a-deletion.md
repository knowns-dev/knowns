---
id: 20260912-1650-a-briefly-missing-file-is-not-a-deletion
title: A briefly missing file is not a deletion
status: draft
supersedes: []
supersededBy: []
tags:
  - history
  - reconciler
  - lifecycle
  - tombstone
  - restore
sources:
  - '@task-KN-00TYF2'
  - '@doc/specs/2026-08-14/shared-task-doc-history-reconciliation'
  - '@doc/specs/2026-09-09/git-backed-shared-knowledge-store-sync'
  - internal/storage/reconciler.go reconcileFile
  - internal/storage/lifecycle_reconciler.go reactivateReappearedEntity
  - internal/storage/history_adapter.go lifecycleCheckpointDroppedContent
relatedDocs:
  - specs/2026-08-14/shared-task-doc-history-reconciliation
  - specs/2026-09-09/git-backed-shared-knowledge-store-sync
relatedTasks:
  - KN-00TYF2
verification: []
reviewState: needs_evidence
reviewBlockers:
  - 'linked task "KN-00TYF2" is "in-progress"; all linked tasks must be done before accepting candidate'
reviewMatches: []
reviewAllowedResolutions: []
reviewEvaluatedHash: 'd25b62e27710f160a8b8a8095981acb607cb2ad4575abc16f246ec62d002a9af'
reviewEvaluatedAt: '2026-09-12T09:50:17.390Z'
createdAt: '2026-09-12T09:50:17.390Z'
updatedAt: '2026-09-12T09:50:17.390Z'
---

## Context

On 2026-09-10 a `git stash -u` removed three untracked Docs for a few seconds. The knowledge watcher recorded delete tombstones after the quiet window. When the files returned byte-identical, reconciliation compared hashes, found them equal, and recorded nothing, so history asserted deletion while the files lived and every later write failed with `Doc canonical hash mismatch`. For a Doc whose last revision was section-scoped, the tombstone was also written without content, because lifecycle checkpoints were built from a version's display Snapshot, which drops content after a section-scoped revision. The repair `reactivateTombstonedEntity` existed and was tested, but `FilesystemReconciler.Restore` had no production caller.

## Decision

1. Lifecycle checkpoints (tombstone and restore) are written from the full replayed entity state, never from a version's display Snapshot.
2. When a live canonical file carries exactly the hash its delete tombstone recorded, reconciliation records a restore instead of reporting the entity unchanged. A Doc with a pending delete transaction is excluded, because there the tombstone records a deletion the user asked for.
3. Replay heals delete and restore checkpoints already written without content by carrying the prior state's content forward when the record's BaseHash proves the lineage. History files are never rewritten to repair them.
4. Tombstone restore is a user-facing operation: MCP `tasks` action `restore` (preview by default), MCP `docs` `restore` without a revision, and CLI `knowns reconcile restore`. Every surface refuses when the file on disk holds content the tombstone did not record.

## Alternatives Considered

Rewrite the corrupt history records in place: rejected, because the hash chain covers every record and D5 of the history reconciliation spec forbids optimistic rewrites. Restore automatically whenever any file reappears: rejected, because a file with different content under a tombstoned identity is not provably the same entity. Expose restore only through the CLI: rejected, because agents work through MCP and would otherwise have no recovery path.

## Consequences

Git checkout, pull, rebase, and stash now converge instead of leaving entities permanently unwritable, which the git-backed store sync spec depends on (its D14). The watcher's observable behaviour changed: a test that asserted reconciliation must not repair a spurious tombstone was rewritten to the new contract. `unarchive` and `restore` are now distinct operations; unarchive reopens an archived Task, restore undoes a recorded deletion.
