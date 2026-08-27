---
id: doc-32b89861c0f68e85a0bfde245ed504af
title: kn-test Skill
description: Specification for a built-in kn-test skill that turns spec Scenarios and ACs into tests and reports AC-level gaps
createdAt: '2026-08-27T04:58:12.531Z'
updatedAt: '2026-08-27T05:10:44.611Z'
tags:
  - spec
  - skills
  - testing
  - draft
  - review-required
---

## Overview

Add `kn-test`, a built-in skill that turns a spec's Scenarios and Acceptance Criteria into actual tests, and reports which criteria no test yet proves.

An audit of all sixteen skill sources found testing is not an owned responsibility anywhere. The word "test" appears roughly 33 times, but only one line in the entire set instructs anyone to *write* a test:

```
internal/instructions/skills/kn-plan/SKILL.md:66
  3. Add or update tests for outcomes and edge cases
```

One bullet, inside a five-step plan template. Everything else is downstream of tests already existing: `kn-implement:92` runs them, `kn-review:86` flags when they are missing, `kn-debug` triages them once red, `kn-research` reads them as evidence. `kn-verify` contains the word zero times — it verifies spec-to-task coverage, not tests, so a project whose entire suite fails still passes it.

The sharper defect is a loop the workflow leaves open. `kn-spec` generates a `## Scenarios` section in Given/When/Then form and its own checklist makes that section mandatory. Exactly one skill reads it — `kn-plan:87`, and only to group requirements into tasks. No skill turns a Scenario into a test case. Meanwhile acceptance criteria are satisfied by bookkeeping rather than evidence:

```
internal/instructions/skills/kn-implement/SKILL.md:111
  When task is marked done (or AC is checked), matching ACs in the
  linked spec document are automatically checked.
```

So a criterion becomes "met" because a task was closed, not because anything demonstrated it. `kn-test` closes that loop.

Related: @doc/specs/2026-08-27/kn-decision-skill established the pattern this follows — give a new skill only the responsibility no existing skill holds.

## Locked Decisions

- D1: `kn-test` derives test cases from a spec's Scenarios and ACs, writes them following existing repository conventions, and reports which ACs no test covers. Running the suite stays with `kn-implement`, triaging failures stays with `kn-debug`, and flagging absent tests during review stays with `kn-review`. The skill takes the design and gap-reporting work that no skill currently owns, and takes nothing that already works.
- D2: `kn-test` becomes a step in the `kn-flow` Execution Loop, placed between implement and review. Unlike `kn-decision`, which is triggered by an exceptional condition and therefore needs only handoff pointers, testing is ordinary cycle work for every behaviour-changing task. A pointer-only integration would leave it unused, because nothing fails to signal that it was skipped. Placing it before review means the reviewer sees code and tests together.
- D3: The mapping from AC or Scenario to test lives in the skill's report and the task notes, not in the test code. No AC identifier is added to test names or comments. The repository's 181 existing test files use descriptive names with no criterion references, and imposing a new convention on them is a larger change than this work justifies.
- D4: `kn-test` reports no coverage percentage and enforces no coverage threshold. The repository configures none anywhere — no `-coverprofile`, no reporting service, no gate — and the only mention is non-enforced prose in `.knowns/docs/development/conventions/checklist.md`. Line coverage also answers a weaker question than the one this skill exists for: a high percentage says nothing about which acceptance criterion is unproven.

Correction, recorded rather than silently patched: D4 originally also cited `CONTRIBUTING.md` as mentioning coverage. Review of the skill found no such text — `grep -i coverage CONTRIBUTING.md` returns nothing. The claim came from an earlier research pass and was wrong. The decision itself is unchanged; only the false supporting citation was removed.

## System Decision Impact

- Impact: none — D1 through D4 are execution rules scoped to this skill and kept canonically in this spec's `Locked Decisions` section.

A judgment worth surfacing rather than burying: D2 adds a mandatory step to the shared orchestration loop, which shapes how every later task is executed and is closer to durable guidance than anything in the kn-decision spec was. It is recorded as `none` because the canonical statement of that rule is `kn-flow/SKILL.md` itself, and the project forbids mirroring scoped spec rules into the System Decision ledger. A reviewer who disagrees should say so before approval rather than after.

## Requirements

### Functional Requirements

- FR-1: A new built-in skill source exists at `internal/instructions/skills/kn-test/SKILL.md` with the standard frontmatter.
- FR-2: The skill documents how to derive concrete test cases from a spec's `## Scenarios` Given/When/Then blocks and from its Acceptance Criteria.
- FR-3: The skill documents how to choose the right test layer for a case, covering the four that exist in this repository: Go unit tests beside the source, Go end-to-end tests under `tests/` that drive the built binary, UI unit tests under `ui/src` using `bun:test`, and UI end-to-end specs under `ui/e2e` using Playwright.
- FR-4: The skill states the repository's real commands rather than generic ones, including the race flag and the count flag that the Makefile uses.
- FR-5: The skill produces a mapping of each AC and Scenario to the test that covers it, marking those with no test.
- FR-6: The skill reports gaps at AC level and contains no coverage percentage, target, or threshold.
- FR-7: The skill states that running the full suite belongs to `kn-implement` and failure triage belongs to `kn-debug`, so the boundaries are explicit rather than inferred.
- FR-8: The skill handles a task with no linked spec by deriving cases from the task's own acceptance criteria.
- FR-9: The skill instructs the reader to say plainly when an AC cannot be proven by an automated test, rather than writing a test that appears to cover it.
- FR-10: `kn-flow`'s Execution Loop includes `kn-test` between implement and review.
- FR-11: The built-in skill count assertion in `internal/instructions/skills/contracts_test.go` is updated from 16 to 17.
- FR-12: Every hardcoded skill roster is updated to include `kn-test` — the nine `SKILL.md` files carrying the shared roster sentence, and the user-facing docs that enumerate skills.

### Non-Functional Requirements

- NFR-1: The skill source is platform-neutral, containing none of the markers `TestBuiltInSkillContracts` rejects.
- NFR-2: The skill's final user-facing response follows the shared order: `Goal/result`, `Key details`, `Next action`.
- NFR-3: The skill is comparable in length to existing skills, roughly 150-320 lines.
- NFR-4: The skill introduces no testing practice the repository does not already have. Specifically it mandates no coverage threshold, no test-first ordering, and no criterion identifiers inside test code.

## Acceptance Criteria

- [ ] AC-1: `go test ./internal/instructions/skills` passes with the count assertion at 17 and `kn-test` present in the embedded set.
- [ ] AC-2: `TestBuiltInSkillContracts` passes for `kn-test`, confirming response-order markers appear in order and no platform-specific marker is present.
- [ ] AC-3: The skill body describes deriving test cases from both Given/When/Then Scenarios and Acceptance Criteria.
- [ ] AC-4: The skill body names all four test layers present in this repository and states which kind of case belongs at each.
- [ ] AC-5: The skill body contains the repository's actual test commands, matching what the Makefile runs.
- [ ] AC-6: The skill body contains no coverage percentage, target, or threshold, and no instruction to run a coverage profile.
- [ ] AC-7: The skill body states that running the suite belongs to `kn-implement` and failure triage to `kn-debug`.
- [ ] AC-8: The skill body specifies the AC-to-test mapping as report output, and instructs against adding criterion identifiers to test names or comments.
- [ ] AC-9: `kn-flow`'s Execution Loop lists kn-test between the implement and review steps.
- [ ] AC-10: The nine roster carriers plus the enumerating docs all list `kn-test`, and the roster sentence remains byte-identical across every carrier.
- [ ] AC-11: After building from source, sync places `kn-test` in the generated platform skill directories.
- [ ] AC-12: `knowns validate --sdd` reports no warnings attributable to this change.

## Scenarios

### Scenario 1: Happy Path — tests derived from a linked spec
**Given** a task linked to a spec that has Scenarios and ACs, with implementation complete
**When** the developer runs `/kn-test`
**Then** the skill lists a test case per Scenario and AC, writes the missing ones at the appropriate layer, and reports a mapping showing which criteria are now covered and which are not

### Scenario 2: Task with no linked spec
**Given** a standalone task with acceptance criteria but no spec
**When** `/kn-test` runs
**Then** cases are derived from the task's own ACs, and the mapping is reported against those instead

### Scenario 3: Edge Case — a criterion no automated test can prove
**Given** an AC that depends on human judgement or an environment the suite cannot reach
**When** the skill reaches that criterion
**Then** it reports the criterion as not automatable with a short reason, rather than writing a test that appears to cover it

### Scenario 4: Edge Case — an existing test already covers a criterion
**Given** an AC already proven by a test written earlier
**When** the skill builds its mapping
**Then** it links the existing test and writes no duplicate

### Scenario 5: Edge Case — coverage percentage requested
**Given** a user asks what the coverage number is
**When** the skill responds
**Then** it reports which ACs lack tests and states that this project configures no coverage tooling, rather than inventing a number or a threshold

### Scenario 6: Orchestrated run
**Given** `kn-flow` is executing a task through its loop
**When** implementation finishes
**Then** the test step runs before review, so the reviewer sees the implementation and its tests together

## Technical Notes

- Canonical source is `internal/instructions/skills/kn-test/SKILL.md`. Generated copies under `.claude/skills/`, `.agents/skills/`, and `.kiro/skills/` are overwritten by sync and are out of implementation scope.
- `//go:embed kn-*` picks up the new directory automatically. Only the hardcoded count in `contracts_test.go` needs editing; `internal/codegen/skill_sync.go` derives its count from the embed FS.
- Verifying the sync criterion requires building from source first. `knowns sync` copies skills from the embed FS of the binary that runs it, not from the source tree, so an installed binary will silently sync the old set and produce nothing. Build with `go build -o /tmp/knowns-dev ./cmd/knowns` and run that.
- Repository test commands, as the Makefile defines them: `go test -v -race -count=1 ./...` for Go unit tests; `cd tests && go test -v -timeout 300s -count=1 -run TestCLI ./...` for CLI end-to-end; `bun test src` for UI unit; `bun test:e2e` for Playwright. CI runs `go vet`, not `golangci-lint`.
- Go tests here use the standard library only. `testify` appears in `go.mod` as an indirect dependency and is not imported by any test. Table-driven cases with `t.Run` subtests are the dominant pattern.

## Task Generation

- Task Prefix: KNT

## Task Links

Generated tasks will be linked here after `/kn-plan --from @doc/specs/2026-08-27/kn-test-skill` runs.

## Open Questions

- [ ] Should `kn-verify` eventually consume the AC-to-test mapping so that spec verification can distinguish "AC checked" from "AC proven by a test"? That would close the bookkeeping gap described in the Overview at the verification layer rather than only at the authoring layer. Out of scope here; it depends on this skill existing first.
- [ ] `.knowns/docs/architecture/overview.md:27` lists the testing stack as "go test + testify", which is inaccurate — testify is unused. Small pre-existing documentation defect, unrelated to this change, worth folding into a docs-accuracy task.
