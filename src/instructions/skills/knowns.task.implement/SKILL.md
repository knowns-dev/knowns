---
name: knowns.task.implement
description: Use when implementing a task - follow the plan, check ACs, track progress
---

# Implementing a Task

Execute the implementation plan, track progress, and complete the task.

**Announce at start:** "I'm using the knowns.task.implement skill to implement task [ID]."

**Core principle:** CHECK AC ONLY AFTER WORK IS DONE.

## The Process

### Step 1: Review Current State

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
- Plan exists and is approved
- Timer is running
- Know which ACs are pending

### Step 2: Check for Applicable Templates

Before writing code, check if there's a template that matches:

```bash
knowns template list
```

**If template exists:**
1. Read linked doc for context
2. Use template to generate boilerplate
3. Customize generated code as needed

{{#if mcp}}
```json
// Read template's linked doc
mcp__knowns__get_doc({ "path": "<template-doc>", "smart": true })
```
```bash
# Generate code from template (reduces context, ensures consistency)
knowns template run <template-name> --name "MyComponent"
```
{{else}}
```bash
# Read template's linked doc
knowns doc "<template-doc>" --plain

# Generate code from template (reduces context, ensures consistency)
knowns template run <template-name> --name "MyComponent"
```
{{/if}}

**Why use templates:**
- Reduces context (no need to generate boilerplate)
- Ensures consistency with project patterns
- Faster implementation

### Step 3: Work Through Plan

For each step in the plan:

1. **Check for template** (use if available)
2. **Do the work** (generate or write code)
3. **Check related AC** (only after work is done!)
4. **Append progress note**

{{#if mcp}}
```json
// After completing work for AC #1:
mcp__knowns__update_task({
  "taskId": "$ARGUMENTS",
  "checkAc": [1],
  "appendNotes": "✓ Done: brief description"
})
```
{{else}}
```bash
# After completing work for AC #1:
knowns task edit $ARGUMENTS --check-ac 1
knowns task edit $ARGUMENTS --append-notes "✓ Done: brief description"
```
{{/if}}

### Step 4: Handle Scope Changes

If new requirements emerge during implementation:

**Small change:**
{{#if mcp}}
```json
mcp__knowns__update_task({
  "taskId": "$ARGUMENTS",
  "addAc": ["New requirement"],
  "appendNotes": "⚠️ Scope: added requirement per user"
})
```
{{else}}
```bash
knowns task edit $ARGUMENTS --ac "New requirement"
knowns task edit $ARGUMENTS --append-notes "⚠️ Scope: added requirement per user"
```
{{/if}}

**Large change:**
- Stop and ask user
- Consider creating follow-up task
- Update plan if needed

### Step 5: Verify & Complete

When all ACs are checked:

**1. Verify code quality:**
```bash
npm test        # or project's test command
npm run lint    # or project's lint command
npm run build   # if applicable
```

**Don't complete if verification fails.** Fix issues first.

**2. Add implementation notes (REQUIRED for audit):**

Document all changes made for audit trail.

> ⚠️ **CRITICAL**: Use `appendNotes` (NOT `notes`). Using `notes` will DESTROY the audit trail!

{{#if mcp}}
```json
mcp__knowns__update_task({
  "taskId": "$ARGUMENTS",
  "appendNotes": "## Implementation Complete\n\n### Files Changed\n- `src/path/file.ts` - Added X\n- `src/path/other.ts` - Modified Y\n\n### Key Changes\n- Change 1: description\n\n### Testing\n- Test coverage / manual testing done"
})
```
{{else}}
```bash
knowns task edit $ARGUMENTS --append-notes $'
## Implementation Complete

### Files Changed
- `src/path/file.ts` - Added X
- `src/path/other.ts` - Modified Y
- `tests/file.test.ts` - Added tests

### Key Changes
- Change 1: description
- Change 2: description

### Testing
- Test coverage / manual testing done
'
```
{{/if}}

**IMPORTANT:** Always use `appendNotes` (not `notes`) to preserve audit trail.

**3. Stop timer and mark done:**

{{#if mcp}}
```json
mcp__knowns__stop_time({ "taskId": "$ARGUMENTS" })
```
```json
mcp__knowns__update_task({
  "taskId": "$ARGUMENTS",
  "status": "done"
})
```
{{else}}
```bash
knowns time stop
knowns task edit $ARGUMENTS -s done
```
{{/if}}

### Step 6: Consider Knowledge Extraction

If generalizable patterns were discovered:

```
/knowns.extract $ARGUMENTS
```

## Progress Tracking

Use concise notes:

{{#if mcp}}
```json
// Good
mcp__knowns__update_task({
  "taskId": "$ARGUMENTS",
  "appendNotes": "✓ Auth middleware implemented"
})

// Bad (too verbose)
mcp__knowns__update_task({
  "taskId": "$ARGUMENTS",
  "appendNotes": "I have successfully completed..."
})
```
{{else}}
```bash
# Good
knowns task edit $ARGUMENTS --append-notes "✓ Auth middleware implemented"

# Bad (too verbose)
knowns task edit $ARGUMENTS --append-notes "I have successfully completed..."
```
{{/if}}

## Completion Checklist

- [ ] All ACs checked
- [ ] Tests pass
- [ ] Lint clean
- [ ] Implementation notes added (with file changes for audit)
- [ ] Timer stopped
- [ ] Status set to `done`
- [ ] Knowledge extracted (if applicable)

## Red Flags

**You're doing it wrong if:**
- Checking AC before work is actually complete
- Making changes not in the approved plan (without asking)
- Skipping tests
- Not tracking progress with notes
- Marking done without verification

## When to Stop

**STOP and ask when:**
- Requirements unclear or contradictory
- Approach isn't working after 2-3 attempts
- Need changes outside approved scope
- Hit unexpected blocker

## If Verification Fails

**Tests failing:**
1. Keep task in-progress
2. Fix the issue
3. Re-run verification

**Forgot to stop timer:**
{{#if mcp}}
```json
mcp__knowns__add_time({
  "taskId": "$ARGUMENTS",
  "duration": "<duration>",
  "note": "Timer correction"
})
```
{{else}}
```bash
knowns time add $ARGUMENTS <duration> -n "Timer correction"
```
{{/if}}

## Remember

- Check AC only AFTER work is done
- Use templates when available
- Track progress with notes
- Ask before scope changes
- Follow the approved plan
- Verify before marking done
- Always stop the timer
- Consider knowledge extraction
