---
name: kn-go
description: Use only when the user explicitly wants the legacy no-review-gates pipeline for an approved spec; prefer kn-flow for normal spec orchestration
---

# Go Mode — Legacy Full Pipeline

**Announce:** "Using kn-go for spec [name]."

**Core principle:** APPROVED SPEC → TASKS → PLAN → IMPLEMENT → VERIFY → COMMIT GATE.

`kn-go` is a compatibility workflow. Use it only when the user explicitly requests the legacy no-review-gates pipeline. For normal approved-spec execution, delegation, parallel safety checks, or integrated review, use `/kn-flow @doc/<spec-path>`.

## Inputs

- Approved spec ref
- Optional `--dry-run` to validate and preview tasks without mutating project state

Stop if the spec is draft, has no ACs, has blocking open questions, or the requested ref cannot be resolved.

## Phase 1: Validate and Discover

1. Read the spec and its complete `Locked Decisions` section.
2. Validate the spec.
3. Resolve existing linked tasks before generating anything.
4. Reuse existing tasks; skip done tasks and continue todo/in-progress work in dependency order.
5. Retrieve only relevant accepted/current System Decisions with bounded filters.

```json
mcp_knowns_docs({ "action": "get", "path": "<spec-path>", "smart": true })
mcp_knowns_validate({ "entity": "<spec-path>" })
mcp_knowns_search({ "action": "resolve", "ref": "@doc/<spec-path>{implements}",
  "direction": "inbound", "entityTypes": "task" })
```

With `--dry-run`, stop after presenting validation plus the task create/reuse preview.

## Phase 2: Create Missing Tasks

Use the same task-shaping rules as `/kn-plan --from @doc/<spec-path>`, but skip its approval gate because the user explicitly selected go mode:

- clean titles and stable `order`; no synthetic `[<slug>-NN]` bracket prefixes
- the spec's optional `Task Generation` → `Task Prefix` passed as `prefix` on each
  create call, or omitted when blank to use the project default
- `spec` link and `fulfills` mapping
- outcome-oriented task ACs
- concise descriptions; implementation detail belongs in task plans
- no duplicate task scope

Report the number of reused and created tasks before implementation begins.

## Phase 3: Execute Sequentially

For each pending task:

1. Take ownership and start its timer.
2. Follow refs and gather bounded project context.
3. Read every applicable Spec Decision and retrieve relevant current System Decisions.
4. Draft and save an executable plan without a per-task approval gate.
5. Implement the plan; check ACs only after outcomes are complete.
6. Run targeted tests, lint/build checks, and task validation.
7. Record `Spec Decision Compliance` for every D-ID.
8. Record exactly one `System Decision Impact` branch:
   - `none — <reason>`, or
   - persisted draft `candidate @decision/<id> (added|changed|removed) — <summary>`
9. Append concise notes, stop the timer, and mark the task done.

Never create Memory category `decision`, duplicate Spec Decisions into the System Decision ledger, or auto-accept a Decision candidate.

If a task fails verification, keep it in-progress or blocked with the exact reason. Do not check incomplete ACs. Skip dependents whose prerequisites are blocked.

## Phase 4: Integrated Verification

After runnable tasks finish:

- run SDD validation
- confirm all linked tasks are done or explicitly blocked
- confirm all Spec Decision compliance and System Decision impact markers
- run project-level test/build/lint commands appropriate to the repository
- report coverage gaps and failures exactly

Do not claim completion while validation or required verification fails.

## Phase 5: Commit Gate

Commit remains the one mandatory user gate in go mode:

1. Review the actual staged scope and exclude unrelated changes.
2. Propose one conventional commit message.
3. Ask for explicit approval before committing.
4. Do not append generator or AI attribution unless explicitly requested or required by project conventions.

## Context and Re-run Behavior

When context becomes constrained, finish the current safe checkpoint, report completed/blocked/remaining tasks, and instruct the user to invoke the same spec again. Re-runs must resolve existing tasks, skip done work, and continue without duplicating tasks or ACs.

## Shared Output Contract

Return information in this order:

1. **Goal/result** — what the pipeline completed, partially completed, or blocked.
2. **Key details** — tasks reused/created/completed, blockers, SDD coverage, Decision compliance, and verification status.
3. **Next action** — commit approval or the exact unblock/resume command.

## Checklist

- [ ] User explicitly requested legacy go mode
- [ ] Spec is approved and valid
- [ ] Existing tasks resolved before creating missing tasks
- [ ] Task ACs are outcome-oriented and checked only after completion
- [ ] Each task was planned, verified, validated, and lifecycle-complete
- [ ] Decision compliance and impact markers are complete
- [ ] Integrated SDD and project verification passed or failures were reported
- [ ] Commit waits for explicit approval
