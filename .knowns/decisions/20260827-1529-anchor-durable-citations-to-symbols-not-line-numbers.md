---
id: 20260827-1529-anchor-durable-citations-to-symbols-not-line-numbers
title: Anchor durable citations to symbols, not line numbers
status: draft
supersedes: []
supersededBy: []
tags:
  - provenance
  - citations
  - staleness
  - evidence
  - workflow
sources:
  - internal/search/engine.go
  - '@task-npgfm4'
relatedDocs: []
relatedTasks:
  - npgfm4
verification: []
reviewState: needs_evidence
reviewBlockers:
  - 'linked task "npgfm4" is "todo"; all linked tasks must be done before accepting candidate'
reviewMatches: []
reviewAllowedResolutions: []
reviewEvaluatedAt: '2026-08-27T08:29:12.066Z'
createdAt: '2026-08-27T08:29:12.066Z'
updatedAt: '2026-08-27T08:29:12.066Z'
---

## Context

`path:line` is the provenance unit across Knowns — task descriptions, Decision `sources` and `verification`, doc evidence, review findings. Line numbers move whenever the file above them changes, and nothing in the system notices.

A verified instance exists in this repository, in the task whose whole purpose is to fix the retrieval measurement gate. @task-npgfm4 cites `internal/search/engine.go:1254` for `topK = opts.Limit * 2` and `:1723` for the per-chunk score bonus. Checked on 2026-08-27:

- `engine.go:1254` now holds an unrelated SQL query for a `code` chunk
- `engine.go:1723` now holds a `ChunkTypeDecision` key assignment
- the logic the task actually describes is at `engine.go:1302` (`topK := opts.Limit * 2`) and `engine.go:1783` (`finalScore += sr.scores[i] * 0.1 // 10% bonus per additional relevant chunk`)

`engine.go` took three commits between the task being written on 2026-08-22 and 2026-08-27. Five days produced two dead pointers in a task nobody had reason to distrust.

This is a different failure from stale prose. The task's words are still correct; only its pointers rotted. A keyword or content-based staleness check cannot detect it, because there is nothing wrong with the text.

## Decision

In durable records — task descriptions, Decision `sources` and `verification`, doc evidence, extracted patterns — cite code by a stable anchor rather than a bare line number:

- prefer the symbol: `internal/search/engine.go` → `hybridSearch`, or a quoted code fragment distinctive enough to grep
- when a line number genuinely helps a reader, pair it with the anchor so the anchor survives the drift: `engine.go:1302 (topK := opts.Limit * 2)`
- never make a line number the only way to find what a record refers to

Transient records — a review finding on a specific diff, a debugging note within one session — may keep bare `path:line`, because they are consumed before the code moves.

## Alternatives Considered

Add a validator that re-checks every cited line still contains the described code. Rejected as the primary fix: it requires the record to declare what it expects to find at that line, which is the anchor this Decision asks for anyway — so the anchor is the cheaper half, and the validator becomes optional once anchors exist.

Auto-rewrite drifted citations by locating the moved code. Rejected: it edits durable records without review, which conflicts with the project's Anti-Goal 3 on autonomous in-place evolution of trusted knowledge.

Accept the drift as unavoidable. Rejected: the evidence shows it takes five days and three commits to break a citation, and the resulting record looks trustworthy while pointing at nothing.

## Consequences

No code changes. This binds authoring behaviour in skills that write durable records — `kn-plan`, `kn-implement`, `kn-extract`, `kn-decision`, `kn-research`, `kn-review` — and those skills are not yet updated to state it. Updating them is follow-up work, not part of this draft.

@task-npgfm4 keeps its original line numbers; a note recording the drift and the correct locations was appended rather than rewriting the description, so the instance stays visible as evidence.

Existing durable records across the repository still use bare `path:line` and are not retro-fitted by this Decision.
