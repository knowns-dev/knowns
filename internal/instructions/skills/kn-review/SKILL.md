---
name: kn-review
description: Use when reviewing implemented code before committing — multi-perspective review with severity-based findings
---

# Code Review

Post-implementation quality review. Run after `kn-implement`, before `kn-commit`.

**Announce:** "Using kn-review for task [ID] (or current changes)."

**Core principle:** MULTI-PERSPECTIVE REVIEW → SEVERITY TRIAGE → FIX P1 → COMMIT.

## When to Use

- After implementing a task, before committing
- When user says "review my code", "check this", "review before commit"
- As the review step inside `/kn-flow` after each task or integrated wave
- As part of `/kn-go` pipeline (optional — can be enabled)

If the user asks to review and finish a whole approved spec or task wave, route to `/kn-flow @doc/<spec-path>` so review is paired with implementation and combined verification.

## Inputs

- Task ID (optional — if provided, reviews against task ACs and spec)
- Current git diff (always)

## Step 1: Gather Review Context

```bash
git diff --stat
git diff
```

If task ID provided:
```json
mcp_knowns_tasks({ "action": "get", "taskId": "$ARGUMENTS" })
```

If task has spec:
```json
mcp_knowns_docs({ "action": "get", "path": "<spec-path>", "smart": true })
```

Search for relevant conventions and past review patterns:
```json
mcp_knowns_search({ "action": "search", "query": "<feature area>", "type": "memory" })
```

---

## Step 2: Multi-Perspective Review

Review the diff from 4 perspectives. For each, produce findings with severity.

### 2a. Code Quality

- Readability and simplicity
- DRY — duplicated logic
- Error handling — missing or swallowed errors
- Type safety — any `any`, unsafe casts, missing types
- Naming — unclear variable/function names

### 2b. Architecture

- Separation of concerns — business logic in handlers, UI logic in components
- Coupling — tight dependencies between unrelated modules
- API design — consistent patterns, proper HTTP methods/status codes
- File organization — follows project conventions

### 2c. Security

- Input validation — user input sanitized
- Auth — proper authorization checks
- Secrets — no hardcoded credentials or tokens
- Data exposure — sensitive data in logs, responses, or error messages

### 2d. Completeness

- Missing tests for new logic
- Edge cases not handled
- Integration gaps — new code not wired into existing flows
- Stubs or TODOs left in code
- ACs from task not fully met (if task provided)

---

## Step 3: Triage Findings

Classify each finding:

| Severity | Criteria | Action |
|----------|----------|--------|
| **P1** | Security vuln, data corruption, breaking change, stub shipped | **Blocks commit — must fix** |
| **P2** | Performance issue, architecture concern, missing test | Should fix before commit |
| **P3** | Minor cleanup, naming, style | Record for later |

**Calibration:** Not everything is P1. Severity inflation wastes time. When in doubt, P2.

---

## Step 4: Report Findings

Present findings grouped by severity:

```
Review Complete — [task-id or "current changes"]
═══════════════════════════════════════════════

P1 (blocks commit): X findings
- [file:line] Description — why it's critical

P2 (should fix): X findings
- [file:line] Description — impact

P3 (nice to have): X findings
- [file:line] Description

Verdict: PASS / BLOCKED (P1 exists)
```

---

## Step 5: Handle Results

### If P1 findings exist — HARD GATE

> ⛔ P1 findings block commit. Fix these first:
> 1. [Finding + suggested fix]
> 2. [Finding + suggested fix]
>
> After fixing, run `/kn-review` again.

Do NOT proceed to commit. Do NOT offer to skip P1.

### If only P2/P3

> ✓ No blocking issues. P2 findings recommended:
> 1. [Finding + suggested fix]
>
> Options:
> - Fix P2s now, then `/kn-commit`
> - If running inside `/kn-flow`, return to the flow after fixing or explicitly deferring P2s
> - Commit as-is: `/kn-commit`
> - Create follow-up task for P2s

### If clean

> ✓ Review passed. No issues found.
>
> Ready: `/kn-commit`

---

## Step 6: Track Findings (optional)

If P2 findings are deferred, create a follow-up task:

```json
mcp_knowns_tasks({ "action": "create", "title": "Review follow-up: <summary>",
  "description": "P2 findings from review of task-<id>:\n- Finding 1\n- Finding 2",
  "priority": "low",
  "labels": ["review-followup"]
})
```

---

## Artifact Verification (if task has spec)

For each deliverable in the spec, verify 3 levels:

1. **EXISTS** — file/component/route exists
2. **SUBSTANTIVE** — not a stub (no `return null`, empty handlers, TODO-only implementations)
3. **WIRED** — imported and used in the integration layer

Report:
- ✅ L1+L2+L3: fully wired
- ⚠️ L1+L2 only: created but not integrated → P2
- 🛑 L1 only (stub): exists but empty → P1
- 🛑 Missing: not found → P1

---

## Shared Output Contract

Required order for the final user-facing response:

1. Goal/result — review verdict (PASS / BLOCKED / PASS with warnings).
2. Key details — findings by severity, artifact verification status, suggested fixes.
3. Next action — `/kn-commit` if passed, fix instructions if blocked.

For `kn-review`, the key details should cover:

- finding count by severity
- specific file:line references for each finding
- whether artifact verification passed (if spec-linked)
- concrete fix suggestions for P1/P2

---

## Related Skills

- `/kn-flow @doc/<spec-path>` — orchestrate review as part of full spec/task-wave execution
- `/kn-implement <id>` — implement before review
- `/kn-commit` — commit after review passes
- `/kn-verify` — SDD-level verification (broader than code review)

## Checklist

- [ ] Diff reviewed from 4 perspectives
- [ ] Findings triaged by severity
- [ ] P1 findings block commit
- [ ] Artifact verification done (if spec linked)
- [ ] Returned control to `/kn-flow` when reviewing inside an active flow
- [ ] Next step suggested

## Red Flags

- Approving code with P1 findings
- Marking stubs as complete
- Not checking the actual diff (reviewing from memory)
- Severity inflation — calling everything P1
- Skipping security perspective
- Reviewing one task as if the whole spec is complete when `/kn-flow` is needed
