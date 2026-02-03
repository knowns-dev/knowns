---
name: knowns.task.reopen
description: Use when reopening a completed task to add new requirements, fix issues, or extend functionality
---

# Reopening Tasks

Reopen completed tasks properly with time tracking and requirement documentation.

**Announce at start:** "I'm using the knowns.task.reopen skill to reopen task [ID]."

**Core principle:** DOCUMENT WHY THE TASK IS REOPENED.

## The Process

### Step 1: View Current Task State

{{#if mcp}}
```json
mcp__knowns__get_task({ "taskId": "$ARGUMENTS" })
```
{{else}}
```bash
knowns task $ARGUMENTS --plain
```
{{/if}}

Verify:
- Task is currently `done`
- Understand what was implemented
- Review implementation notes

### Step 2: Reopen and Start Timer

{{#if mcp}}
```json
// Set back to in-progress
mcp__knowns__update_task({
  "taskId": "$ARGUMENTS",
  "status": "in-progress"
})

// Start timer (REQUIRED)
mcp__knowns__start_time({ "taskId": "$ARGUMENTS" })
```
{{else}}
```bash
# Set back to in-progress
knowns task edit $ARGUMENTS -s in-progress

# Start timer (REQUIRED)
knowns time start $ARGUMENTS
```
{{/if}}

### Step 3: Document Reopen Reason

> ⚠️ **Use `appendNotes` (NOT `notes`)** to preserve existing audit trail:

{{#if mcp}}
```json
mcp__knowns__update_task({
  "taskId": "$ARGUMENTS",
  "appendNotes": "🔄 Reopened: <reason>"
})
```
{{else}}
```bash
knowns task edit $ARGUMENTS --append-notes "🔄 Reopened: <reason>"
```
{{/if}}

**Common reasons:**
- User requested changes
- Bug found in implementation
- New requirements added
- Missed acceptance criteria

### Step 4: Add New Requirements

{{#if mcp}}
```json
mcp__knowns__update_task({
  "taskId": "$ARGUMENTS",
  "addAc": ["New requirement 1", "Fix: issue description"]
})
```
{{else}}
```bash
# Add new acceptance criteria
knowns task edit $ARGUMENTS --ac "New requirement 1"
knowns task edit $ARGUMENTS --ac "Fix: issue description"
```
{{/if}}

### Step 5: Update Plan (if needed)

{{#if mcp}}
```json
mcp__knowns__update_task({
  "taskId": "$ARGUMENTS",
  "plan": "Previous plan + new steps:\n1. Original step (done)\n2. Original step (done)\n3. NEW: Address new requirement\n4. NEW: Fix reported issue"
})
```
{{else}}
```bash
knowns task edit $ARGUMENTS --plan $'Previous plan + new steps:
1. Original step (done)
2. Original step (done)
3. NEW: Address new requirement
4. NEW: Fix reported issue'
```
{{/if}}

**Present updated plan and WAIT for approval.**

### Step 6: Implement and Complete

Follow normal task completion flow:

{{#if mcp}}
```json
// Check new ACs as completed
mcp__knowns__update_task({
  "taskId": "$ARGUMENTS",
  "checkAc": [<new-index>],
  "appendNotes": "✓ Done: new requirement"
})

// Stop timer
mcp__knowns__stop_time({ "taskId": "$ARGUMENTS" })

// Mark done again
mcp__knowns__update_task({
  "taskId": "$ARGUMENTS",
  "status": "done"
})
```
{{else}}
```bash
# Check new ACs as completed
knowns task edit $ARGUMENTS --check-ac <new-index>
knowns task edit $ARGUMENTS --append-notes "✓ Done: new requirement"

# Stop timer
knowns time stop

# Mark done again
knowns task edit $ARGUMENTS -s done
```
{{/if}}

## When to Reopen vs Create New Task

| Reopen Existing | Create New Task |
|-----------------|-----------------|
| Small fix/change | Major new feature |
| Related to original work | Unrelated work |
| Same context needed | Different context |
| Quick addition | Significant scope |

**Rule of thumb:** If it takes < 30 mins and relates to original task, reopen. Otherwise, create new task with reference.

## Creating Follow-up Task Instead

{{#if mcp}}
```json
mcp__knowns__create_task({
  "title": "Follow-up: <description>",
  "description": "Related to @task-$ARGUMENTS"
})
```
{{else}}
```bash
knowns task create "Follow-up: <description>" \
  -d "Related to @task-$ARGUMENTS" \
  --ac "New requirement"
```
{{/if}}

## Remember

- Always document reopen reason
- Start timer when reopening
- Add new AC for traceability
- Stop timer when done
- Consider if new task is more appropriate
