---
id: 20260903-1654-persisted-filesystem-paths-are-stored-in-their-on-disk-spelling
title: Persisted filesystem paths are stored in their on-disk spelling
status: draft
supersedes: []
supersededBy: []
tags:
  - registry
  - paths
  - cross-platform
sources:
  - 'https://github.com/knowns-dev/knowns/issues/144'
  - '@doc/specs/browser-any-pwd-and-workspace-switching'
relatedDocs:
  - specs/browser-any-pwd-and-workspace-switching
relatedTasks:
  - zyxxj7
verification: []
reviewState: ready_for_review
reviewBlockers: []
reviewMatches: []
reviewAllowedResolutions:
  - accept_new
  - reject_new
reviewEvaluatedAt: '2026-09-03T09:55:02.736Z'
createdAt: '2026-09-03T09:54:14.381Z'
updatedAt: '2026-09-03T09:55:02.736Z'
---

## Context

The workspace registry keyed projects by the exact path string it was handed. On Windows and the default macOS filesystem, two capitalizations of one folder are the same directory but two different strings, so one project accumulated multiple registry rows (GitHub issue knowns-dev/knowns#144). Auto-scan made it routine rather than rare, because its candidate list carries both capitalizations of every well-known project folder.

## Decision

Any filesystem path Knowns persists or compares as an identity key is first resolved to its on-disk spelling with util.CanonicalPath, which walks each component against its parent's directory listing and accepts a case-insensitive match only when os.SameFile proves the two spellings name one directory. Case folding by platform is not used, because on a case-sensitive filesystem two directories differing only in capitalization are genuinely different and must stay distinct. Readers of an existing store canonicalize on load and collapse rows that turn out to name one path, so stores written before this rule repair themselves.

## Alternatives Considered

Comparing case-insensitively on Windows and macOS was rejected: it needs a platform switch, and it silently merges distinct directories when a store is shared or synced across platforms. Keying the registry on the stable id in .knowns/config.json is the more robust design and remains open, but it changes the registry format and needs a migration.

## Consequences

Path identity is decided by the filesystem rather than by string comparison, so it stays correct on all three platforms with one code path. Canonicalization costs one directory read per path component, which is acceptable at registry and scan frequency but should not be placed in a hot loop. Paths that do not exist on disk keep the caller's spelling and are never merged.
