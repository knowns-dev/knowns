---
name: kn-flow
description: Use when orchestrating a full Knowns spec or task wave through planning, implementation, review, integration, and verification, optionally using sub-agents when scopes are parallel-safe.
---

# Spec Flow Orchestration

Coordinate an approved spec, linked task set, or explicit task wave from planning through implementation, review, and verification.

**Announce:** "Using kn-flow for spec/task wave [ref]."

**Core principle:** APPROVED SPEC/TASK WAVE -> SCHEDULE -> PLAN -> IMPLEMENT -> REVIEW -> VERIFY.

## When to Use

- After `/kn-spec` approves a spec and the user wants the work completed end to end
- When the user says "do all tasks", "complete this spec", "orchestrate sub-agents", "run the whole flow", or similar
- When multiple linked tasks need dependency ordering, ownership boundaries, review, and combined verification

## When NOT to Use

- Draft specs or unresolved product questions -> use `/kn-spec`
- A single task with an existing plan -> use `/kn-implement <id>`
- Creating tasks only, without execution -> use `/kn-plan --from @doc/<spec-path>`
- Tiny standalone work -> use `/kn-plan --new "<summary>"`

## Inputs

- Spec ref: `@doc/<spec-path>` preferred
- Task IDs: one or more explicit tasks for a task wave
- Optional: `--sequential` to force single-threaded execution
- Optional: `--plan-only` to stop after plans and schedule

## Startup

1. Start with Knowns MCP `initial`.
2. Read `kn-plan`, `kn-implement`, and `kn-review` before using their procedures.
3. Read the spec or each explicit task.
4. Search first, then follow explicit refs and retrieve only relevant context.
5. Do not manually edit Knowns-managed task or doc markdown.

## Task Discovery

For a spec ref:

1. Read the spec.
2. List tasks linked to the spec.
3. Sort by `order`, then shared `[slug-NN]` title prefix, then title.
4. If no tasks exist, use `/kn-plan --from @doc/<spec-path>` behavior to preview tasks. Ask before creating tasks unless the user explicitly approved task creation.

For explicit task IDs:

1. Read every task.
2. Follow refs needed to understand dependencies and verification.
3. Sort by dependency order when visible; otherwise preserve user order.

## Parallel Gate

Before spawning workers or implementing in waves, decide what can safely run together.

For each task, note:

- dependencies
- owned write scope
- expected verification
- shared API/schema/config/generated artifact/runtime contract risk
- parallel-safe: yes/no

Only run tasks in parallel when dependencies and write scopes are disjoint and no shared runtime contract is touched. Default to sequential execution when safety is unclear.

Report the schedule before implementation.

## Execution Loop

For each task or parallel-safe wave:

1. Run `/kn-plan <task-id>` behavior if no saved plan exists or if the plan is stale.
2. Run `/kn-implement <task-id>` behavior to complete the saved plan.
3. Run `/kn-review <task-id>` behavior against the real diff.
4. Fix P1 findings. Fix P2 findings when practical, or explicitly defer them with a follow-up task.
5. Validate the task before marking the wave complete.

If sub-agent tools are available, use them only after the parallel gate marks tasks safe. If sub-agent tools are unavailable, execute the same schedule sequentially in the main context.

## Worker Prompt

Use this shape when spawning an implementation worker:

```text
Worker for <TASK_ID> in <SPEC_REF>. Use kn-implement.
Owned scope: <OWNERSHIP_SCOPE>.
Do not revert unrelated changes.
Implement the saved plan, verify it, validate the task, and report changed files, tests, ACs, blockers, and out-of-scope edits.
```

## Reviewer Prompt

Use this shape when spawning a review worker:

```text
Reviewer for <TASK_ID> in <SPEC_REF>. Use kn-review.
Review the real diff and report verdict, P1/P2/P3 findings with file:line refs, wiring status, fixes, and verification gaps.
```

## After Each Wave

1. Inspect worker output directly.
2. Integrate or reject worker changes in the main context.
3. Run combined verification for touched areas.
4. Re-run review if integration changed reviewed code.
5. Close sub-agents after their work has been integrated or rejected.

## Final Verification

Before calling the flow done:

- all linked spec tasks are done or explicitly blocked
- task ACs are checked only after implementation
- SDD validation passes for the spec/task set
- broad verification ran across the integrated diff
- useful durable memory is captured
- sub-agents are closed

## Shared Output Contract

Required order for the final user-facing response:

1. Goal/result - state what spec/task wave completed, partially completed, or blocked.
2. Key details - tasks completed, review results, verification, validation, blockers, and important files.
3. Next action - usually `/kn-commit` when the flow is clean, or the exact unblock command/context when blocked.

## Related Skills

- `/kn-spec` - create and approve a spec before flow orchestration
- `/kn-plan --from @doc/<spec-path>` - generate tasks from a spec without executing them
- `/kn-plan <id>` - plan one task inside the flow
- `/kn-implement <id>` - implement one task inside the flow
- `/kn-review <id>` - review one task or integrated wave
- `/kn-verify` - final SDD verification
- `/kn-commit` - commit after the flow is complete and reviewed

## Checklist

- [ ] Spec/tasks read
- [ ] Linked tasks discovered and sorted
- [ ] Parallel gate reported
- [ ] Plans exist for all runnable tasks
- [ ] Implementation completed per task
- [ ] Reviews completed and P1 fixed
- [ ] Combined verification passed
- [ ] SDD validation passed
- [ ] Durable memory captured when useful
- [ ] Sub-agents closed
- [ ] Next action suggested

## Red Flags

- Running on a draft spec
- Creating tasks without approval
- Parallelizing tasks with shared APIs, schema, config, generated files, migrations, or runtime contracts
- Trusting worker output without inspecting the real diff
- Skipping review before final verification
- Marking the spec done while linked tasks remain unhandled
- Committing or pushing without explicit user request
