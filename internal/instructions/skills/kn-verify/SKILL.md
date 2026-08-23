---
name: kn-verify
description: Use when running SDD verification and coverage reporting
---

# SDD Verification

Run validation with SDD-awareness to check spec coverage and task status.

**Announce:** "Using kn-verify to check SDD status."

**Core principle:** VERIFY SPEC COVERAGE → REPORT WARNINGS → SUGGEST FIXES.

## Inputs

- Entire project SDD state, or a narrower entity if the user asked for focused validation

## Verification Rules

- Report concrete warnings before general commentary
- Prefer actionable fixes over generic advice
- Separate coverage problems from broken refs or missing links
- Require complete `Spec Decision Compliance` markers for in-review/done linked tasks; any conflict is a validation failure
- Require every in-review/done linked task to record exactly one valid impact branch:
  - `System Decision Impact: none — <reason>` creates no candidate
  - `System Decision Impact: candidate @decision/<id> (added|changed|removed) — <summary>` resolves to a persisted non-current candidate linked to originating work
- Keep unverified draft/replacement Decisions out of current guidance
- Keep Spec Decisions canonical in the spec's `Locked Decisions` section; ledger duplication is a validation failure
- Treat new Memory category `decision` as legacy workflow drift and require first-class Decision capture instead
- When gathering context, retrieve only relevant accepted/current System Decisions with bounded filters; do not serialize all Decisions

## Step 1: Run SDD Validation

### Via CLI
```bash
knowns validate --sdd --plain
```

### Via MCP (if available)
```json
mcp_knowns_validate({ "scope": "sdd" })
```

## Step 2: Present SDD Status

Return the verification result using the shared output contract:

- Goal/result: whether SDD validation passed, failed, or surfaced warnings
- Key details: coverage summary, explicit warnings, passing checks, and the highest-priority fixes
- Next action: only when the warnings point to a clear follow-up command

The key-details portion may include a compact status block such as:

```
Specs:    X total | Y approved | Z draft
Tasks:    X total | Y done | Z in-progress | W todo
Coverage: X/Y tasks linked to specs (Z%)
Warnings:
- task-XX has no spec reference
- specs/feature: X/Y ACs incomplete
Passed:
- All spec references resolve
- specs/auth: fully implemented
- Spec Decisions: all linked D-IDs assessed with no conflicts
- System Decision Impact: declared and lifecycle-valid
- System Decision Impact refs: persisted with task/spec/source provenance
```

## Step 3: Analyze Results

**Good coverage (>80%):**
> SDD coverage is healthy. All tasks are properly linked to specs.

**Medium coverage (50-80%):**
> Some tasks are missing spec references. Consider:
> - Link existing tasks to specs: `knowns task edit <id> --spec specs/<name>`
> - Create specs for unlinked work: `/kn-spec <feature-name>`

**Low coverage (<50%):**
> Many tasks lack spec references. For better traceability:
> 1. Create specs for major features: `/kn-spec <feature>`
> 2. Link tasks to specs: `knowns task edit <id> --spec specs/<name>`
> 3. Use `/kn-plan --from @doc/specs/<name>` for new tasks

## Step 4: Suggest Actions

Based on warnings, add the most relevant fixes inside the key-details section, then give one best next command only if a natural handoff exists:

**For tasks without spec:**
> Link task to spec:
> ```json
> mcp_knowns_tasks({ "action": "update", >   "taskId": "<id>",
>   "spec": "specs/<name>"
> })
> ```

**For incomplete ACs:**
> Check task progress:
> ```bash
> knowns task <id> --plain
> ```

**For approved specs without tasks:**
> Continue the approved spec through orchestration:
> ```
> /kn-flow @doc/specs/<name>
> ```
>
> If the user only wants task generation:
> ```
> /kn-plan --from @doc/specs/<name>
> ```

## Entity-Specific Validation (Optional)

To validate a single task or doc (saves tokens):

```json
// Validate single task
mcp_knowns_validate({ "entity": "abc123" })

// Validate single doc
mcp_knowns_validate({ "entity": "specs/user-auth" })
```

## Shared Output Contract

All built-in skills in scope must end with the same user-facing information order: `kn-init`, `kn-spec`, `kn-flow`, `kn-plan`, `kn-research`, `kn-handoff`, `kn-implement`, `kn-verify`, `kn-doc`, `kn-template`, `kn-extract`, and `kn-commit`.

Required order for the final user-facing response:

1. Goal/result - state what validation confirmed, failed, or blocked.
2. Key details - include the most important supporting context, refs, coverage, warnings, or fixes.
3. Next action - recommend a concrete follow-up command only when a natural handoff exists.

Keep this concise for CLI use. Verification-specific content may extend the key-details section, but must not replace or reorder the shared structure.

Do not manage platform-synced skill copies; this source defines the built-in workflow contract.

For `kn-verify`, the key details should cover:

- coverage summary
- explicit warnings
- concrete follow-up actions
- whether the project is healthy enough to continue or needs cleanup first

When verification reveals a clear follow-up, include the best next command. If the project is already healthy and no immediate workflow continuation is obvious, stop after the result and key details.

## Related Skills

- `/kn-flow @doc/<spec-path>` - Continue an approved spec with pending or missing task execution
- `/kn-plan --from @doc/<spec-path>` - Generate tasks only when verification shows an approved spec has none
- `/kn-review <id>` - Review implemented work before final verification

## Checklist

- [ ] Ran validate --sdd
- [ ] Presented status report
- [ ] Reported Spec Decision compliance and validated every System Decision Impact marker/ref
- [ ] Confirmed no Spec Decision ledger duplication or new Decision Memory capture
- [ ] Analyzed coverage level
- [ ] Suggested specific fixes for warnings
- [ ] Suggested `/kn-flow` when an approved spec has pending execution

## Red Flags

- Ignoring warnings
- Not suggesting actionable fixes
- Skipping coverage analysis
- Claiming coverage is healthy without showing evidence
- Suggesting manual task-by-task work when `/kn-flow` is the better approved-spec handoff
- Treating a missing System Decision Impact marker as a harmless warning
- Treating a ready draft candidate as current guidance
