---
name: kn-plan
description: Use when creating an implementation plan for a task
---

# Planning Work

**Core principle:** GATHER CONTEXT → PLAN → VALIDATE → WAIT FOR APPROVAL.

## Modes

- `/kn-plan <task-id>` — plan an existing task
- `/kn-plan --new "<summary>"` — create a bounded task, then plan it
- `/kn-plan --from @doc/<spec-path>` — preview and create tasks from an approved spec

If the user wants end-to-end execution of an approved spec or task wave, route to `/kn-flow @doc/<spec-path>`.

## Shared Preflight

- Read the primary task or spec before searching adjacent context.
- Follow every explicit `@task-`, `@doc/`, and `@template/` ref recursively.
- Read a linked spec's complete `Locked Decisions` section and enumerate every D-ID.
- Retrieve only relevant accepted/current System Decisions with bounded filters.
- Search docs, memories, related tasks, and templates only as needed.
- Stop on a missing primary source, unreadable rule, broken critical ref, or concrete Decision conflict.

## Existing Task Mode

**Announce:** "Using kn-plan for task [ID]."

1. Read the task and confirm it is not already done unless reopening is intended.
2. Take ownership and start its timer. If another timer cannot be safely paused or replaced, surface that conflict rather than silently changing it.
3. Gather bounded context from refs, related docs/tasks, code patterns, memories, templates, and relevant Decisions.
4. Draft an outcome-oriented implementation plan.
5. Save the plan to the task.
6. Validate the task and run the plan-quality checks below.
7. Present the plan and wait for explicit approval before implementation.

```json
mcp_knowns_tasks({ "action": "get", "taskId": "<id>" })
mcp_knowns_tasks({ "action": "update", "taskId": "<id>",
  "status": "in-progress", "assignee": "@me" })
mcp_knowns_time({ "action": "start", "taskId": "<id>" })
```

## New Task Mode

**Announce:** "Using kn-plan to create and plan a new task."

Classify the summary:

- **tiny/normal:** create a concise task, then continue with Existing Task Mode
- **high-risk or broadly ambiguous:** recommend `/kn-spec` unless the user explicitly bypasses it

High-risk work includes auth/authorization, data migration or loss, public contracts, security/audit, external integration changes, or broad cross-module behavior.

Create the task before planning. Use outcome-oriented ACs when enough requirements are known; otherwise record assumptions and unresolved questions in the plan instead of inventing certainty.

## Plan Requirements

A saved plan should normally contain 3–8 ordered steps and identify concrete files or refs when known:

```markdown
1. Establish or reuse the relevant project pattern (see @doc/...)
2. Implement the bounded behavior in <area>
3. Add or update tests for outcomes and edge cases
4. Update managed docs/configuration when required
5. Run targeted and project-level validation
```

Plan-quality checks:

- Every task AC maps to at least one plan step.
- Every plan step contributes to a task outcome.
- Dependencies are ordered and not circular.
- New dependencies and shared/core changes are flagged.
- Testing, lint/build, validation, and manual verification are explicit where applicable.
- Every Spec Decision is reported as `D<ID>=pass` or `D<ID>=conflict: <reason>`.
- A conflict blocks approval until the task, spec, or plan is reconciled.
- If the plan exceeds about eight steps or a step spans too many independent files/subsystems, recommend splitting.

## Generate Tasks From Spec

**Announce:** "Using kn-plan to generate tasks from spec [name]."

1. Read and validate the exact spec path.
2. Parse requirements, ACs, scenarios, Locked Decisions, and existing Task Links.
3. Resolve existing linked tasks and reuse overlapping work.
4. Group requirements into independently completable tasks.
5. Preview tasks and wait for explicit approval.
6. Create approved tasks and update the spec's concise `Task Links` section through Knowns APIs.

Each task should have:

- title `[<slug>-NN] <outcome>` with stable zero-padded order
- concise description and spec link
- `fulfills` mapped to Spec AC IDs
- outcome-oriented, testable task ACs
- labels `from-spec`, `spec:<slug>`, and `spec-date:<yyyy-mm-dd>`
- order `NN * 10`

Implementation mechanics belong in the later task plan, not in task ACs.

Example creation shape:

```json
mcp_knowns_tasks({ "action": "create", "title": "[<slug>-NN] <outcome>",
  "description": "<bounded outcome>", "spec": "<spec-path>",
  "fulfills": ["AC-1"], "priority": "medium",
  "labels": ["from-spec", "spec:<slug>", "spec-date:<yyyy-mm-dd>"],
  "order": 10 })
```

## Validation and Approval

After saving a plan or creating tasks:

```json
mcp_knowns_validate({ "entity": "<task-id-or-spec-path>" })
```

Fix validation errors before requesting approval. Planning never implies implementation approval.

## Final Response Contract

Return information in this order:

1. **Goal/result** — task created, plan produced, task preview produced, or planning blocked.
2. **Key details** — concise plan/tasks, refs, assumptions, Decision compliance, validation, and approval status.
3. **Next action** — one natural handoff only.

Typical handoffs:

- approved task plan → `/kn-implement <task-id>`
- approved generated task set → `/kn-flow @doc/<spec-path>`
- high-risk ambiguous request → `/kn-spec <feature>`
- no clear handoff → wait for the user's review

Do not manage platform-synced skill copies; this source defines the built-in workflow contract.

## Checklist

- [ ] Primary task/spec read and refs followed
- [ ] Ownership/timer handled safely for an existing task
- [ ] Relevant templates and current Decisions considered
- [ ] Plan or task ACs are outcome-oriented
- [ ] AC coverage, dependency, risk, and Decision checks passed
- [ ] Entity validation passed
- [ ] Explicit approval requested before implementation or task creation
