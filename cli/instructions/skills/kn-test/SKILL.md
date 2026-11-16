---
name: kn-test
description: Use when turning a spec's Scenarios and acceptance criteria into tests, and reporting which criteria no test proves
---

# Writing Tests From Criteria

**Announce:** "Using kn-test for [task or spec]."

**Core principle:** A CRITERION IS PROVEN BY A TEST, NOT BY A CLOSED TASK.

Acceptance criteria get checked as bookkeeping — ticked by hand, or synced onto a spec from tasks already closed. Either way that records intent, not evidence. This skill closes the distance between the two: it turns each criterion and scenario into a test that would fail if the behaviour were absent, and reports plainly which criteria still have nothing proving them.

## Inputs

- A task, with or without a linked spec
- The spec's `## Scenarios` and `## Acceptance Criteria` when one is linked
- The implementation being tested, already written

## Preflight

- Read the linked spec's Scenarios and Acceptance Criteria in full before writing anything.
- Search for tests that already cover the behaviour. A criterion already proven needs mapping, not a second test.
- Read two or three neighbouring test files in the area you are about to touch. Match what they do rather than what you would do elsewhere.

## What This Skill Owns

Deriving cases, writing them, and reporting what remains uncovered.

It does not own the rest of the testing story, and should not duplicate it:

| Concern | Owner |
|---------|-------|
| Running the suite as part of finishing a task | `kn-implement` |
| Diagnosing and fixing a failing test | `kn-debug` |
| Flagging absent tests while reviewing a diff | `kn-review` |
| Spec-to-task coverage | `kn-verify` |

You will run tests here to confirm the ones you just wrote actually pass and actually fail for the right reason. That is not the same as owning suite execution.

## Step 1: Derive Cases

**From a Scenario.** Given/When/Then already has the shape of a test: `Given` is setup, `When` is the call, `Then` is the assertion. Translate it directly rather than paraphrasing it into something vaguer.

```
Given a done task linked to a spec with unchecked ACs
When spec-AC sync runs
Then the matching spec ACs are checked
```
becomes a test that seeds that task, invokes the sync, and asserts the spec ACs changed, against the real endpoint.

Translate what the code does, not what you assume it does. The scenario above reads as if closing a task checks the ACs; the implementation is a separate `POST /api/tasks/sync-spec-acs` that scans done tasks (`cli/src/server/routes/tasks.ts`). A test written from the assumption would set up the wrong trigger and prove nothing.

**From an Acceptance Criterion.** An AC states an outcome. Ask what would be observably different if it were not implemented, and assert that difference. If the answer is "nothing observable", the criterion is not testable as written, which is a finding worth reporting rather than working around.

**Edge cases.** A spec's Scenarios usually name a happy path and one or two edges. Those edges are the point. Cover them before adding depth to the happy path.

## Step 2: Choose the Layer

Four layers exist in this repository. Put each case at the cheapest one that can actually prove it.

- **CLI unit** — `*.test.ts` under `cli/test`, mirroring `cli/src`, using `bun:test`. Default choice. Use it for logic, parsing, validation, storage, and anything reachable without spawning the CLI.
- **CLI end-to-end** — under `cli/test/e2e`, spawning the CLI through `runCli` (`harness.ts`) or the MCP stdio client (`mcp-client.ts`). Use it when the behaviour only exists once the CLI or MCP surface is wired together. They run `bun src/main.ts`, or the compiled binary when `KNOWNS_TS_BIN` is set, and create an isolated project and HOME per test.
- **UI unit** — `*.test.ts` under `ui/src`, using `bun:test`. Use it for pure functions and helpers.
- **UI end-to-end** — `*.spec.ts` under `ui/e2e`, using Playwright. Use it for anything that needs the rendered app. These run sequentially and each spec manages its own server.

A case that can be proven at the unit layer does not belong at the end-to-end layer. Reaching for the outer layer to avoid thinking about the inner one produces slow tests that fail for unrelated reasons.

## Step 3: Match Existing Conventions

Read the neighbours first, but these hold across the CLI suite:

- `bun:test` only (`describe`, `test`, `expect`). Do not introduce another runner or assertion library.
- `test.each` or a loop of `test` calls for anything with more than two variations.
- A fresh temp directory per test for isolation, removed in `afterEach`/`afterAll`. Every test process already runs with a sandboxed HOME (`cli/test/helpers/sandbox-home.ts`), and fails if the real `~/.knowns` gains temp projects.
- Assertions whose failure message names both values: compare whole objects with `toEqual` rather than one field at a time.
- Fixture projects under `cli/test/fixtures/` when a case needs real stored data; most tests build their data inline, so reach for fixtures only when inline data would obscure the test.
- Differential tests (`*.diff.test.ts`) compare against the frozen Go implementation and skip without it. New behaviour gets an ordinary test, not a new diff test.

## Step 4: Run What You Wrote

```bash
cd cli && bun test test/<area>                       # CLI unit, one area
cd cli && bun run test                               # whole CLI suite
make test-e2e                                        # CLI and MCP end-to-end, compiled binary
cd ui && bun test src                                # UI unit
make test-e2e-ui                                     # UI end-to-end
```

The CLI end-to-end suite runs from source unless `KNOWNS_TS_BIN` points at a compiled binary; `make test-e2e` builds one and sets it. The Playwright specs need a built binary: they throw `Binary not found at ... Run 'make build' first.` and stop. That is why `test-e2e-ui` depends on `all`. Set `TEST_BINARY` instead if you want to point them at a binary you already built elsewhere.

Some suites are gated behind environment variables — `TEST_SEMANTIC=1` for the semantic subsets, `TEST_LSP_FIXTURES=1` for the language-server fixtures. A suite that is skipping is not a suite that is passing; say which one you observed.

Confirm a new test fails for the right reason before you accept that it passes. A test that passes against missing behaviour proves nothing, and is worse than no test because it reads as coverage.

`make lint` is `bun run check` (tsc and biome), the same check CI runs; biome warnings do not fail it, errors do.

## Step 5: Report the Mapping

Produce a table of every criterion and scenario against the test that covers it:

```
AC-1   cli/test/server/rest.diff.test.ts > "sync spec acs"    covered
AC-2   cli/test/e2e/cli.test.ts > "task lifecycle"            covered
AC-3   —                                                      no test
Sc-3   —                                                      not automatable: needs a human judging layout
```

The mapping belongs in this report and in the task notes. Do not encode criterion identifiers in test names or comments — the existing suite names tests after the behaviour they prove, and that convention is worth keeping.

Report gaps at criterion level. Do not report a coverage percentage or hold work to a coverage threshold: this project configures neither, and a line percentage cannot tell you which criterion is unproven.

## Handling The Awkward Cases

**No linked spec.** Derive cases from the task's own acceptance criteria and map against those instead. The method does not change.

**A criterion no automated test can prove.** Say so, with the reason, in the mapping. Something depending on human judgement, an external service, or a real device belongs in the report as not automatable — not covered by a test that only appears to address it.

**A criterion already covered.** Link the existing test and move on. A second test asserting the same thing adds maintenance and proves nothing new.

## Shared Output Contract

All built-in skills in scope must end with the same user-facing information order: `kn-init`, `kn-spec`, `kn-flow`, `kn-go`, `kn-plan`, `kn-research`, `kn-handoff`, `kn-implement`, `kn-test`, `kn-review`, `kn-debug`, `kn-decision`, `kn-verify`, `kn-doc`, `kn-template`, `kn-extract`, and `kn-commit`.

Required order for the final user-facing response:

1. Goal/result - state what was covered, what was left uncovered, and whether the new tests pass.
2. Key details - include the criterion-to-test mapping, the suites actually run, and any criterion reported as not automatable.
3. Next action - recommend a concrete follow-up command only when a natural handoff exists.

Keep this concise for CLI use. Testing-specific content may extend the key-details section, but must not replace or reorder the shared structure.

Do not manage platform-synced skill copies; this source defines the built-in workflow contract.

For `kn-test`, the key details should cover:

- which criteria are now proven and by which test
- which criteria remain unproven, and whether that is a gap or a limit
- which suites ran, and which skipped
- tests written versus existing tests merely mapped

A criterion left uncovered is a normal outcome to report, not a failure to hide.

## Related Skills

- `/kn-implement <id>` - writes the implementation and runs the suite as part of finishing
- `/kn-debug` - takes over when a test fails and the cause is not obvious
- `/kn-review <id>` - reviews the diff, including whether new logic arrived without tests
- `/kn-spec` - produces the Scenarios and ACs this skill derives from
- `/kn-verify` - checks spec-to-task coverage, which is a different question from test coverage

## Checklist

- [ ] Spec Scenarios and ACs read in full before writing
- [ ] Existing tests searched, so nothing already proven is written twice
- [ ] Each case placed at the cheapest layer that can prove it
- [ ] Neighbouring test files matched for style and structure
- [ ] Each new test confirmed to fail for the right reason before passing
- [ ] Suites that skipped reported as skipped, not as passing
- [ ] Mapping produced for every criterion and scenario
- [ ] Criteria that cannot be automated reported with a reason
- [ ] No criterion identifiers added to test names or comments
- [ ] No coverage percentage or threshold reported

## Red Flags

- Checking an acceptance criterion because the code looks right
- Writing a test that passes without the implementation present
- Reporting a skipped suite as a passing one
- Reaching for end-to-end when a unit test would prove the same thing
- Introducing another test runner or assertion library the suite does not use
- Adding AC identifiers to test names to make mapping easier
- Reporting a coverage percentage, or treating one as a goal
- Quietly omitting a criterion from the mapping because no test covers it
- Duplicating a test that already proves the criterion
- Taking over suite execution or failure triage from the skills that own them
