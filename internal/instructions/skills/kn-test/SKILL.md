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
becomes a test that seeds that task, invokes the sync, and asserts the spec ACs changed. `internal/server/routes/tasks_spec_ac_archive_test.go:TestSyncSpecACsCountsArchivedTasks` is that shape against the real endpoint.

Translate what the code does, not what you assume it does. The scenario above reads as if closing a task checks the ACs; the implementation is a separate `POST /api/tasks/sync-spec-acs` that scans done tasks (`internal/server/routes/tasks.go:494`). A test written from the assumption would set up the wrong trigger and prove nothing.

**From an Acceptance Criterion.** An AC states an outcome. Ask what would be observably different if it were not implemented, and assert that difference. If the answer is "nothing observable", the criterion is not testable as written, which is a finding worth reporting rather than working around.

**Edge cases.** A spec's Scenarios usually name a happy path and one or two edges. Those edges are the point. Cover them before adding depth to the happy path.

## Step 2: Choose the Layer

Four layers exist in this repository. Put each case at the cheapest one that can actually prove it.

- **Go unit** — `*_test.go` beside the source. Default choice. Use it for logic, parsing, validation, and anything reachable without a built binary.
- **Go end-to-end** — under `tests/`, driving the compiled binary through `runCli` or the MCP stdio client. Use it when the behaviour only exists once the CLI or MCP surface is wired together. These build the binary if it is missing and create an isolated project per test.
- **UI unit** — `*.test.ts` under `ui/src`, using `bun:test`. Use it for pure functions and helpers.
- **UI end-to-end** — `*.spec.ts` under `ui/e2e`, using Playwright. Use it for anything that needs the rendered app. These run sequentially and each spec manages its own server.

A case that can be proven at the unit layer does not belong at the end-to-end layer. Reaching for the outer layer to avoid thinking about the inner one produces slow tests that fail for unrelated reasons.

## Step 3: Match Existing Conventions

Read the neighbours first, but these hold across the Go suite:

- Standard library `testing` only. `testify` is an indirect dependency and is imported by no test — do not introduce it.
- Table-driven cases with `t.Run` subtests for anything with more than two variations.
- `t.TempDir()` for isolation, `t.Helper()` on helpers, `t.Cleanup` for teardown.
- Assertions as plain `t.Errorf`/`t.Fatalf` with a `got`/`want` message that names both values.
- Fixture data as JSON under a package's `testdata/` directory when a case needs it. The one worked example is `internal/search/testdata/`; most packages need no fixtures at all, so reach for this only when inline data would obscure the test.

## Step 4: Run What You Wrote

```bash
go test -v -race -count=1 ./...                                   # Go unit
cd tests && go test -v -timeout 300s -count=1 -run TestCLI ./...  # CLI end-to-end
cd tests && go test -v -timeout 300s -count=1 -run TestMCP ./...  # MCP end-to-end
cd ui && bun test src                                             # UI unit
make build && (cd ui && bun test:e2e)                             # UI end-to-end
```

The Go suites build the binary themselves when it is missing. The Playwright specs do not — they throw `Binary not found at ... Run 'make build' first.` and stop. That is why the UI line above builds first, and why the Makefile's `test-e2e-ui` target depends on `all`. Set `TEST_BINARY` instead if you want to point them at a binary you already built elsewhere.

Some suites are gated behind environment variables — `TEST_SEMANTIC=1` for the semantic subsets, `TEST_LSP_FIXTURES=1` for the language-server fixtures. A suite that is skipping is not a suite that is passing; say which one you observed.

Confirm a new test fails for the right reason before you accept that it passes. A test that passes against missing behaviour proves nothing, and is worse than no test because it reads as coverage.

Note that CI runs `go vet`, not `golangci-lint`. A clean local `make lint` is not the check that gates the branch.

## Step 5: Report the Mapping

Produce a table of every criterion and scenario against the test that covers it:

```
AC-1   internal/server/routes/tasks_spec_ac_archive_test.go:TestSyncSpecACsCountsArchivedTasks   covered
AC-2   tests/e2e_cli_test.go:TestCLI_TaskLifecycle                                               covered
AC-3   —                                                                                         no test
Sc-3   —                                                                                         not automatable: needs a human judging layout
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
- Introducing testify or another assertion library the suite does not use
- Adding AC identifiers to test names to make mapping easier
- Reporting a coverage percentage, or treating one as a goal
- Quietly omitting a criterion from the mapping because no test covers it
- Duplicating a test that already proves the criterion
- Taking over suite execution or failure triage from the skills that own them
