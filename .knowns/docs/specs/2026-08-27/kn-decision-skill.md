---
id: doc-6afc5fdcf7783fce12ef87cf49017a1c
title: kn-decision Skill
description: Specification for a built-in kn-decision skill that owns the System Decision lifecycle
createdAt: '2026-08-27T04:07:52.365Z'
updatedAt: '2026-08-27T04:39:41.542Z'
tags:
  - spec
  - skills
  - decision
  - draft
  - review-required
---

## Overview

Add `kn-decision`, a built-in skill that owns the System Decision lifecycle.

System Decisions are the most pervasive concept in the Knowns workflow contract and the only first-class entity with no owning skill. An audit of `internal/instructions/skills/*/SKILL.md` found the word "decision" in **13 of 15 skills** across 129 lines, yet exactly **one** call site that operates on a Decision:

```
internal/instructions/skills/kn-implement/SKILL.md:124
  mcp_knowns_decision({ "action": "create", ...
```

Every skill *enforces* Decision rules — `kn-verify` fails validation on a missing or invalid `System Decision Impact` marker, `kn-review` raises P1 when a draft is treated as current before explicit human resolution, `kn-implement` blocks task completion without exactly one impact branch — but no skill teaches how to create, triage, promote, or supersede a Decision.

The result is a gate with no key: an agent is blocked by Decision rules and has no documented path through them. This spec closes that gap.

Related: @doc/specs/skill-output-contract

## Locked Decisions

- D1: `kn-decision` owns the eight day-to-day lifecycle actions — `create`, `list`, `get`, `link`, `review_inbox`, `resolve`, `accept`, `supersede`. The three migration actions (`migration_preview`, `migration_apply`, `migration_rollback`) are explicitly out of scope: legacy Decision Memory migration is a one-time administrative operation with its own rollback path and seven distinct resolutions, and folding it in would dilute the skill's focus.
- D2: `kn-implement` keeps its in-flow candidate creation at `kn-implement/SKILL.md:124` unchanged. `kn-decision` adds a standalone creation path for Decisions that arise outside task work (for example during `kn-spec` or `kn-review`) and owns the entire lifecycle from draft onward. Two creation entry points, one lifecycle owner.
- D3: Read operations and draft creation run without asking. Every operation that changes binding project guidance — `accept`, `supersede`, and the `accept_new`, `supersede_existing`, `reject_new` resolutions — must stop for explicit human confirmation. This mirrors the approval gate in `kn-spec` and matches the rules already enforced by `kn-verify` ("explicit verified human resolution") and `kn-review` (P1 when a draft is treated as current).
- D4: `kn-decision` is invoked manually and is also the handoff target from the three enforcing skills. `kn-verify`, `kn-review`, and `kn-implement` gain a next-action pointer to `/kn-decision` in their existing handoff sections only; no enforcement logic changes.

## System Decision Impact

- Impact: none — D1 through D4 are execution rules scoped to this skill and are kept canonically in this spec's `Locked Decisions` section. The only current System Decision (`20260819-1703-remove-the-opencode-chat-ui`) is unrelated. Adding a workflow skill does not change durable system guidance.

## Requirements

### Functional Requirements

- FR-1: A new built-in skill source exists at `internal/instructions/skills/kn-decision/SKILL.md` with the standard frontmatter (`name`, `description`).
- FR-2: The skill documents each of the eight in-scope actions from D1 with its purpose and invocation shape.
- FR-3: The skill documents the five `resolve` resolutions — `accept_new`, `supersede_existing`, `create_draft`, `link_as_related`, `reject_new` — and states which are gated per D3.
- FR-4: The skill explicitly declares the three migration actions out of scope and directs the reader elsewhere rather than leaving them undocumented.
- FR-5: The skill marks `accept`, `supersede`, `accept_new`, `supersede_existing`, and `reject_new` as requiring explicit human confirmation before execution.
- FR-6: The skill documents the standalone creation path and states that `kn-implement` remains the in-flow creation path, so the two do not appear to compete.
- FR-7: `kn-verify`, `kn-review`, and `kn-implement` each reference `/kn-decision` as a next action when Decision rules are triggered.
- FR-8: The built-in skill count assertion in `internal/instructions/skills/contracts_test.go` is updated from 15 to 16.
- FR-9: Every hardcoded skill roster is updated to include `kn-decision` — the eight `SKILL.md` files carrying the "All built-in skills in scope" list, and the user-facing docs that enumerate skills.

### Non-Functional Requirements

- NFR-1: The skill source is platform-neutral. It must not contain `In Codex`, `Generated with Claude Code`, or `.claude/skills/*`, which `TestBuiltInSkillContracts` rejects.
- NFR-2: The skill's final user-facing response follows the shared output contract order: `Goal/result`, `Key details`, `Next action`.
- NFR-3: The skill is concise enough for CLI use and comparable in length to existing lifecycle skills (roughly 150-320 lines).
- NFR-4: The skill describes actions in terms of the `decision` tool contract, without duplicating the tool's full parameter schema.

## Acceptance Criteria

- [ ] AC-1: `go test ./internal/instructions/skills` passes with the count assertion at 16 and `kn-decision` present in the embedded set.
- [ ] AC-2: `TestBuiltInSkillContracts` passes for `kn-decision`, confirming `Goal/result`, `Key details`, and `Next action` appear in that order and no platform-specific marker is present.
- [ ] AC-3: All eight in-scope actions from D1 appear in the skill body; none of `migration_preview`, `migration_apply`, `migration_rollback` appear as instructions to perform.
- [ ] AC-4: Each of the five gated operations from D3 carries an explicit stop-for-confirmation instruction in the skill body.
- [ ] AC-5: `kn-verify`, `kn-review`, and `kn-implement` each contain a `/kn-decision` reference in a handoff or related-skills section.
- [ ] AC-6: The eight `SKILL.md` files that hardcode the skill roster, plus the enumerating docs, all list `kn-decision`.
- [ ] AC-7: `kn-implement/SKILL.md:124` still creates a candidate in-flow; its behaviour is unchanged apart from the added next-action pointer.
- [ ] AC-8: After `knowns sync`, `kn-decision` appears in the generated platform skill directories alongside the other built-ins.
- [ ] AC-9: `knowns validate --sdd` reports no new warnings attributable to this change.

## Scenarios

### Scenario 1: Happy Path — draft raised in-flow, resolved afterwards
**Given** a task recorded a `System Decision Impact` candidate branch naming a persisted draft Decision during `kn-implement`
**When** the developer runs `/kn-decision`
**Then** the skill lists pending drafts via `review_inbox`, presents the candidate with its linked evidence, proposes a resolution, stops for explicit confirmation, and only then calls `resolve`

### Scenario 2: Decision arises outside task work
**Given** a durable constraint surfaces while writing a spec, with no task in flight
**When** the developer runs `/kn-decision`
**Then** the skill creates the Decision with status `draft`, links the originating spec and sources, and does not attempt to accept it

### Scenario 3: Edge Case — agent must not self-accept
**Given** a draft Decision the agent judges well-evidenced
**When** the agent reaches the point of promoting it
**Then** it stops and asks for confirmation instead of calling `accept`, because an accepted Decision binds all subsequent work

### Scenario 4: Edge Case — migration is out of scope
**Given** the user asks to migrate legacy Decision Memory entries
**When** `/kn-decision` is invoked
**Then** the skill states migration is out of scope per D1 and points to the migration actions rather than performing them

### Scenario 5: Edge Case — verification gate signposts the way out
**Given** `knowns validate --sdd` reports a missing or malformed `System Decision Impact` marker
**When** `kn-verify` presents its findings
**Then** its next action names `/kn-decision`, so the blocked agent has a documented path forward

## Technical Notes

- Canonical source is `internal/instructions/skills/kn-decision/SKILL.md`. The generated copies under `.claude/skills/`, `.agents/skills/`, and `.kiro/skills/` are overwritten by sync and are out of implementation scope.
- `//go:embed kn-*` in `internal/instructions/skills/embed.go` picks up a new directory automatically; no embed change is needed. Only the hardcoded count in `contracts_test.go` requires editing.
- The `decision` tool exposes statuses `draft`, `accepted`, `superseded`, `rejected`, `archived`. The skill should describe transitions in those terms.
- `accept` supports a `supersedes` array for atomically retiring current Decisions on promotion; this is a gated path under D3.

## Task Generation

- Task Prefix: KND

## Task Links

Generated tasks will be linked here after `/kn-plan --from @doc/specs/2026-08-27/kn-decision-skill` runs.

## Open Questions

- [ ] Should `kn-init` surface pending Decision drafts at session start via `review_inbox`? Considered and deferred during exploration — it would keep drafts from accumulating unnoticed, but expands scope to `kn-init` and lengthens session-start output. Track separately if wanted.
- [ ] Spillover: @doc/specs/skill-output-contract carries two conflicting rosters (a ten-skill scope list and a "14 skills" clarification), and both omit `kn-handoff`. This predates the current change and should be corrected under its own task rather than inside this spec.
