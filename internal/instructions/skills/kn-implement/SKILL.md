---
name: kn-implement
description: Use when implementing a task - follow the plan, check ACs, track progress
---

# Implementing a Task

Execute the implementation plan, track progress, and complete the task.

**Announce:** "Using kn-implement for task [ID]."

**Core principle:** CHECK AC ONLY AFTER WORK IS DONE.

## Inputs

- Task ID
- Existing implementation plan
- Linked spec, docs, templates, and referenced tasks

## Preflight

- Confirm a plan exists; if not, redirect to `/kn-plan <id>` first unless user explicitly overrides
- Read task notes and pending ACs before changing code
- Identify whether the task is standalone or linked to a spec
- If the request is to complete an approved spec or multiple linked tasks, route to `/kn-flow @doc/<spec-path>` instead of implementing a single task in isolation
- If linked to a spec, load the spec only as needed for requirements/AC context; do not pull a long task list into the prompt
- If linked to a spec, read every rule in its canonical `Locked Decisions` section before changing code. An unreadable rule or concrete conflict blocks implementation.
- Retrieve relevant accepted/current System Decisions with `sourceTypes:["decision"]`, `status:"accepted"`, `includeHistorical:false`, and a bounded task query.
- Decide what verification is required: tests, lint, build, validation, manual checks

## Step 1: Review Task

```json
mcp_knowns_tasks({ "action": "get", "taskId": "$ARGUMENTS" })
```

**If task status is "done"** (reopening):
```json
mcp_knowns_tasks({ "action": "update", "taskId": "$ARGUMENTS",
  "status": "in-progress",
  "appendNotes": "Reopened: <reason>"
})
mcp_knowns_time({ "action": "start", "taskId": "$ARGUMENTS" })
```

Verify: plan exists, timer running, which ACs pending.

## Step 2: Check Templates

```json
mcp_knowns_templates({ "action": "list" })
```

If template exists → use it to generate boilerplate.

## Step 3: Work Through Plan

For each step:
1. Do the work
2. Check AC (only after done!)
3. Append note

```json
mcp_knowns_tasks({ "action": "update", "taskId": "$ARGUMENTS",
  "checkAc": [1],
  "appendNotes": "Done: brief description"
})
```

Working rules:

- Append compact progress notes at meaningful checkpoints, not after every tiny edit
- If a step reveals missing context, pause implementation and gather it before continuing
- If the task needs docs or template changes, do them as part of completion, not as an afterthought
- Use `search` to discover relevant sources; use `retrieve` when implementation needs assembled context with citations for docs, tasks, and memories.
- Prefer MCP `mcp_knowns_search({ "action": "retrieve", "query": "<keywords>" })` for retrieval; fall back to CLI `knowns retrieve "<keywords>" --json` if MCP is unavailable.

## Step 4: Handle Scope Changes

**Small:** Add AC + note
```json
mcp_knowns_tasks({ "action": "update", "taskId": "$ARGUMENTS",
  "addAc": ["New requirement"],
  "appendNotes": "Scope: added per user"
})
```

**Large:** Stop and ask user.

## Step 5: Validate & Complete

1. Run tests/lint/build
2. **Validate task** to catch broken refs (uses entity filter to save tokens):

```json
mcp_knowns_validate({ "entity": "$ARGUMENTS" })
```

3. Run the System Decision Impact checkpoint below. Do not mark the task done without exactly one impact marker.
4. Append `Spec Decision Compliance: D1=pass, D2=pass` for every Locked Decision in the linked spec. Record `conflict: <reason>` and stop instead of completing when any rule is violated.
5. Add implementation notes (use `appendNotes`, NOT `notes`!)
6. Stop timer + mark done

```json
mcp_knowns_time({ "action": "stop", "taskId": "$ARGUMENTS" })
mcp_knowns_tasks({ "action": "update", "taskId": "$ARGUMENTS",
  "status": "done"
})
```

**Note:** When task is marked done (or AC is checked), matching ACs in the linked spec document are automatically checked. No manual spec update needed.

### System Decision Impact checkpoint

Ask: **Did this completed work add, change, or remove durable project guidance that future work must follow?**

Durable guidance includes architecture, product behavior, workflow conventions, naming, storage models, API contracts, and explicit tradeoffs.

- **No** — create no Decision candidate. Append:
  `System Decision Impact: none — <short reason>`
- **Yes** — create a first-class **draft System Decision candidate** before completion. Link the originating task, linked spec/doc, and every readable source available. Never auto-accept it.

```json
mcp_knowns_decision({ "action": "create",
  "title": "<durable guidance title>",
  "status": "draft",
  "decision": "<current guidance future work should follow>",
  "sources": ["@doc/<source-path>"],
  "relatedDocs": ["<linked-spec-or-doc-path>"],
  "relatedTasks": ["<task-id>"]
})
```

Append the persisted candidate returned by the tool:
`System Decision Impact: candidate @decision/<id> (added|changed|removed) — <short summary>`

If review checks find missing evidence or a duplicate/conflict, leave the candidate unresolved in Review Inbox. Passing checks makes it ready for human review; it never makes the candidate current automatically.

Spec Decisions are different: keep every D-ID canonically in the spec's `Locked Decisions` section and report compliance only. Do not copy Spec Decision text into the System Decision ledger merely for display.

## Step 5.5: SDD Workflow (if task has spec)

**Check if task has `spec` field.** If yes, run SDD workflow:

### 1. Get Sibling Tasks

```json
mcp_knowns_tasks({ "action": "list", "spec": "<spec-path-from-task>" })
```

Use the returned task metadata as a compact sibling summary. Sort siblings by:
1. `order` when present
2. explicit dependency information when available
3. title as fallback

Do not infer workflow order from a generated Task ID or a synthetic title prefix.
Existing bracket-prefixed titles remain valid content but carry no ordering meaning.

Do not fetch every sibling task body unless a dependency or status inconsistency requires it.

### 2. Analyze Status

Count tasks by status:
- `done`: completed tasks
- `todo` / `in-progress`: pending tasks

### 3. Branch Based on Results

**If pending tasks exist:**
```
✓ Task done! This task is part of spec: <spec-path>

Remaining tasks (Y of Z):
- USER-4F7Q2M: Add refresh token rotation (todo)
- USER-9K2P6R: Add session revocation (in-progress)

Next: /kn-flow @doc/<spec-path> to orchestrate the remaining tasks, or /kn-plan <first-todo-id> for manual task-by-task work
```

**If this is the LAST task (all others done):**
```
✓ Task done! All tasks for <spec-path> complete!

Running SDD verification...
```

Then auto-run:
```json
mcp_knowns_validate({ "scope": "sdd" })
```

Display SDD Coverage Report:
```
SDD Coverage Report
═══════════════════════════════════════
Spec: <spec-path>
Tasks: X/X complete (100%)
ACs: Y/Z verified

✅ Spec fully implemented!
```

## Step 6: Capture Durable Knowledge (optional)

Before final response, use the completed System Decision Impact checkpoint and then capture other durable knowledge:

- Use a first-class Decision for stable choices: architecture, product behavior, workflow convention, naming, storage model, API contract, or explicit tradeoff. Link it to the source task/doc/reference, and supersede older Decisions instead of overwriting them.
- Use Memory for concise reusable recall that should surface quickly in future sessions.
- Use Docs for long-form explanations, examples, or broader knowledge.

If patterns, decisions, or failures need structured extraction: `/kn-extract`

If a quick insight is worth remembering but does not warrant a full doc:
```json
mcp_knowns_memory({ "action": "add", "title": "<insight>",
  "content": "<2-3 sentence summary>",
  "layer": "project",
  "category": "<pattern|convention|preference|failure>",
  "tags": ["<domain>"]
})
```

Never create a Memory with category `decision`; that category is legacy. If a user or workflow asks to add a Decision Memory, redirect it to the first-class Decision candidate flow above.

## Final Response Contract

All built-in skills in scope must end with the same user-facing information order: `kn-init`, `kn-spec`, `kn-flow`, `kn-plan`, `kn-research`, `kn-handoff`, `kn-implement`, `kn-verify`, `kn-doc`, `kn-template`, `kn-extract`, and `kn-commit`.

Required order for the final user-facing response:

1. Goal/result - state what was implemented, confirmed, or what remains blocked.
2. Key details - include the most important supporting context, verification, refs, or spec status.
3. Next action - recommend a concrete follow-up command only when a natural handoff exists.

Keep this concise for CLI use. Skill-specific content may extend the key-details section, but must not replace or reorder the shared structure.

Do not manage platform-synced skill copies; this source defines the built-in workflow contract.

For `kn-implement`, the key details should cover:

- whether the task is done or what remains
- tests, validation, lint, or build status
- any spec-related follow-up or remaining sibling-task context

---

## CRITICAL: Next Step Suggestion

**You MUST suggest the next action when a natural follow-up exists. User won't know what to do next.**

After task completion, check for:

1. **More tasks from same spec?**
   ```json
   mcp_knowns_tasks({ "action": "list", "spec": "<spec-path>", "status": "todo" })
   ```
   Sort results by `order` or `[<slug>-NN]` before choosing the next task.

2. **Suggest based on context:**

| Situation | Suggest |
|-----------|---------|
| More tasks in spec | "Next: `/kn-flow @doc/<spec-path>` to orchestrate remaining tasks, or `/kn-plan <next-task-id>` for manual flow" |
| All spec tasks done | "All tasks complete! Run `/kn-verify` to verify against spec" |
| Standalone task | "Task done. Run `/kn-extract` to extract patterns, or `/kn-commit` to commit" |
| Patterns discovered | "Consider `/kn-extract` to document this pattern" |

**Example output:**
```
✓ Task USER-2QW7VT complete!

Next task from @doc/specs/2026-06-17/user-auth:
→ USER-4F7Q2M: Add refresh token rotation

Run: /kn-plan USER-4F7Q2M
```

---

## Related Skills

- `/kn-flow @doc/<spec-path>` - Continue or complete the surrounding spec/task wave
- `/kn-plan <id>` - Create plan before implementing
- `/kn-verify` - Verify all tasks against spec
- `/kn-extract` - Extract patterns to docs
- `/kn-commit` - Commit with verification

## Checklist

- [ ] All ACs checked
- [ ] Tests pass
- [ ] **Validated (no broken refs)**
- [ ] `System Decision Impact` marker recorded as `none` or a persisted candidate ref
- [ ] Positive impact created a first-class draft Decision linked to task/spec/sources
- [ ] Spec Decision Compliance marker recorded for every linked D-ID
- [ ] Notes added
- [ ] Timer stopped
- [ ] Status = done
- [ ] **SDD workflow handled with sorted sibling summary (if spec linked)**
- [ ] Routed remaining spec work to `/kn-flow` when appropriate
- [ ] **Next step suggested**

## Red Flags

- Checking AC before work done
- Skipping tests
- Skipping validation
- Using `notes` instead of `appendNotes`
- Marking done without verification
- Marking done without a `System Decision Impact` marker
- Creating Memory category `decision` instead of a first-class Decision candidate
- Copying Spec Locked Decisions into the System Decision ledger
- **Not checking sibling tasks when spec linked**
- **Not running SDD verify when spec complete**
- **Not suggesting next step**
- Implementing from a vague task without clarifying plan/context
- Silently expanding scope instead of asking
