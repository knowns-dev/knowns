---
id: 20260827-1528-retire-fully-superseded-specs-and-docs-by-deleting-them-never-by-bannering-them-in-place
title: Retire fully superseded specs and docs by deleting them, never by bannering them in place
status: draft
supersedes: []
supersededBy: []
tags:
  - workflow
  - docs
  - staleness
  - skills
  - supersession
sources:
  - internal/instructions/skills/kn-implement/SKILL.md
  - internal/instructions/skills/kn-flow/SKILL.md
  - '@doc/features/init-process'
  - '@doc/features/model-command'
  - internal/cli/provider.go
relatedDocs:
  - features/init-process
  - features/model-command
  - specs/chat-ui
relatedTasks:
  - 6i2roz
verification: []
reviewState: needs_evidence
reviewBlockers:
  - 'linked task "6i2roz" is "todo"; all linked tasks must be done before accepting decision "20260827-1528-retire-fully-superseded-specs-and-docs-by-deleting-them-never-by-bannering-them-in-place"'
reviewMatches: []
reviewAllowedResolutions: []
reviewEvaluatedAt: '2026-08-27T08:28:37.408Z'
createdAt: '2026-08-27T08:28:03.625Z'
updatedAt: '2026-08-27T08:28:37.408Z'
---

## Context

The System Decision Impact checkpoint in `kn-implement` and `kn-flow` told a completing task to create a draft Decision and append an impact marker, but said nothing about retiring the document the work replaced. The result was that supersession was recorded as a banner or tag on a document that stayed resident in `.knowns/docs/`.

An adversarial review of this repository found the failure had already occurred here, under a single maintainer using the tool daily:

- `.knowns/docs/features/init-process.md` has `tags: []` — no staleness marker of any kind — and still walks a new user through "Group 3: Chat UI / Enable Chat UI? (confirm)" (lines 77-78), "Download ONNX Runtime / Download model files" (lines 105-106, 222), and `knowns model download <model>` (line 223). The Chat UI was removed in full by @decision/20260819-1703-remove-the-opencode-chat-ui, and `internal/cli/provider.go:118-121` records that `knowns model` was removed with the local ONNX path.
- `.knowns/docs/features/model-command.md` is tagged `superseded` in its frontmatter, yet its body still documents `knowns model` in the present tense (line 22), while `docs/en/reference/commands.md:342` correctly states "There is no `knowns model` command."
- Of 45 spec documents in `.knowns/docs/specs/`, 7 are tagged `superseded` and 4 are tagged `partially-superseded`, all still resident.

A banner does not stop a document being returned by search, and it does not change the body text, which still reads as current instruction. The banner records the rot; it does not remove it.

## Decision

When completed work fully supersedes a spec or doc, delete that document in the same change. Record the supersession in the superseding Decision's `consequences`, not in the retired document.

When the work only partially voids a document, do not delete it. Name the void parts explicitly — for example `FR-5`, `AC-6`, `Scenario 4` — and leave the remainder live.

This distinction is load-bearing. @decision/20260819-1703-remove-the-opencode-chat-ui already applies it correctly, marking `specs/knowns-hub-mode` as "Partially void, NOT superseded" with a named list of void requirements. Treating `superseded` and `partially-superseded` as the same tag and deleting both would destroy guidance that is still in force.

## Alternatives Considered

Keep bannering and add a separate cleanup pass. Rejected: it defers the work to a moment that never arrives, and the evidence above is what deferral produces. The cost of deleting is lowest at the moment the superseding work is done, when the author knows exactly what the replacement covers.

Automate staleness detection by re-embedding docs and scoring drift against code. Rejected under the project's own Anti-Goal 7 ("Do not use multi-agent orchestration by default. Complexity should be justified by a measurable win over the simple phased baseline") — it adds a subsystem to detect a problem that a one-sentence workflow rule prevents at the source.

## Consequences

`internal/instructions/skills/kn-implement/SKILL.md` gains a "Retire what the work replaced" block in the System Decision Impact checkpoint, plus a checklist item and a red flag. `internal/instructions/skills/kn-flow/SKILL.md` gains the compressed mirror of the rule in checkpoint step 7, plus a red flag. Both were edited and `go test ./internal/instructions/skills/` passes.

The 7 fully superseded specs, `model-command.md`, and the stale sections of `init-process.md` are NOT cleaned up by this Decision. They predate the rule and remain outstanding; cleaning them is a separate, explicitly approved change.

This rule does not catch a second staleness mechanism found in the same review: `path:line` citations rotting as code moves. See the companion draft on citation anchors.
