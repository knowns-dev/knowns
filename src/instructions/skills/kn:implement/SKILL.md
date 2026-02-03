---
name: kn:implement
description: Use when implementing a task - follow the plan, check ACs, track progress
---

# Implementing a Task

Execute the implementation plan, track progress, and complete the task.

**Announce:** "Using kn:implement for task [ID]."

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

## Step 6: Extract Knowledge (optional)

If patterns discovered: `/kn:extract $ARGUMENTS`

## Checklist

- [ ] All ACs checked
- [ ] Tests pass
- [ ] **Validated (no broken refs)**
- [ ] Notes added
- [ ] Timer stopped
- [ ] Status = done

## Red Flags

- Checking AC before work done
- Skipping tests
- Skipping validation
- Using `notes` instead of `appendNotes`
- Marking done without verification
