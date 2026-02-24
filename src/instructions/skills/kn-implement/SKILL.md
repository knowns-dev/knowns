---
name: kn-implement
description: Use when implementing a task - follow the plan, check ACs, track progress
---

# Implementing a Task

Execute the implementation plan, track progress, and complete the task.

**Announce:** "Using kn-implement for task [ID]."

**Core principle:** CHECK AC ONLY AFTER WORK IS DONE.

## Step 1: Review Task

```json
mcp__knowns__get_task({ "taskId": "$ARGUMENTS" })
```

**If task status is "done"** (reopening):
```json
mcp__knowns__update_task({
  "taskId": "$ARGUMENTS",
  "status": "in-progress",
  "appendNotes": "Reopened: <reason>"
})
mcp__knowns__start_time({ "taskId": "$ARGUMENTS" })
```

Verify: plan exists, timer running, which ACs pending.

## Step 2: Check Templates

```json
mcp__knowns__list_templates({})
```

If template exists → use it to generate boilerplate.

## Step 3: Work Through Plan

For each step:
1. Do the work
2. Check AC (only after done!)
3. Append note

```json
mcp__knowns__update_task({
  "taskId": "$ARGUMENTS",
  "checkAc": [1],
  "appendNotes": "Done: brief description"
})
```

## Step 4: Handle Scope Changes

**Small:** Add AC + note
```json
mcp__knowns__update_task({
  "taskId": "$ARGUMENTS",
  "addAc": ["New requirement"],
  "appendNotes": "Scope: added per user"
})
```

**Large:** Stop and ask user.

## Step 5: Validate & Complete

1. Run tests/lint/build
2. **Validate** to catch broken refs:

```json
mcp__knowns__validate({})
```

3. Add implementation notes (use `appendNotes`, NOT `notes`!)
4. Stop timer + mark done

```json
mcp__knowns__stop_time({ "taskId": "$ARGUMENTS" })
mcp__knowns__update_task({
  "taskId": "$ARGUMENTS",
  "status": "done"
})
```

**Note:** When task is marked done (or AC is checked), matching ACs in the linked spec document are automatically checked. No manual spec update needed.

## Step 5.5: SDD Workflow (if task has spec)

**Check if task has `spec` field.** If yes, run SDD workflow:

### 1. Get Sibling Tasks

```json
mcp__knowns__list_tasks({ "spec": "<spec-path-from-task>" })
```

### 2. Analyze Status

Count tasks by status:
- `done`: completed tasks
- `todo` / `in-progress`: pending tasks

### 3. Branch Based on Results

**If pending tasks exist:**
```
✓ Task done! This task is part of spec: specs/xxx

Remaining tasks (Y of Z):
- task-YY: Title (todo)
- task-ZZ: Title (in-progress)

Next: /kn-plan <first-todo-id>
```

**If this is the LAST task (all others done):**
```
✓ Task done! All tasks for specs/xxx complete!

Running SDD verification...
```

Then auto-run:
```json
mcp__knowns__validate({ "scope": "sdd" })
```

Display SDD Coverage Report:
```
SDD Coverage Report
═══════════════════════════════════════
Spec: specs/xxx
Tasks: X/X complete (100%)
ACs: Y/Z verified

✅ Spec fully implemented!
```

## Step 6: Extract Knowledge (optional)

If patterns discovered: `/kn-extract`

---

## CRITICAL: Next Step Suggestion

**You MUST suggest the next action. User won't know what to do next.**

After task completion, check for:

1. **More tasks from same spec?**
   ```json
   mcp__knowns__list_tasks({ "spec": "<spec-path>", "status": "todo" })
   ```

2. **Suggest based on context:**

| Situation | Suggest |
|-----------|---------|
| More tasks in spec | "Next: `/kn-plan <next-task-id>` for [task title]" |
| All spec tasks done | "All tasks complete! Run `/kn-verify` to verify against spec" |
| Standalone task | "Task done. Run `/kn-extract` to extract patterns, or `/kn-commit` to commit" |
| Patterns discovered | "Consider `/kn-extract` to document this pattern" |

**Example output:**
```
✓ Task #43 complete!

Next task from @doc/specs/user-auth:
→ Task #44: Add refresh token rotation

Run: /kn-plan 44
```

---

## Related Skills

- `/kn-plan <id>` - Create plan before implementing
- `/kn-verify` - Verify all tasks against spec
- `/kn-extract` - Extract patterns to docs
- `/kn-commit` - Commit with verification

## Checklist

- [ ] All ACs checked
- [ ] Tests pass
- [ ] **Validated (no broken refs)**
- [ ] Notes added
- [ ] Timer stopped
- [ ] Status = done
- [ ] **SDD workflow handled (if spec linked)**
- [ ] **Next step suggested**

## Red Flags

- Checking AC before work done
- Skipping tests
- Skipping validation
- Using `notes` instead of `appendNotes`
- Marking done without verification
- **Not checking sibling tasks when spec linked**
- **Not running SDD verify when spec complete**
- **Not suggesting next step**
