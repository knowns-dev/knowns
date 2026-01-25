# Task Completion

## Definition of Done

A task is **Done** when ALL of these are complete:

{{#if mcp}}
| Requirement | How |
|-------------|-----|
| All AC checked | `mcp__knowns__update_task` with `checkAc` |
| Notes added | `mcp__knowns__update_task` with `notes` |
| Timer stopped | `mcp__knowns__stop_time` |
| Status = done | `mcp__knowns__update_task` with `status: "done"` |
| Tests pass | Run test suite |
{{else}}
| Requirement | Command |
|-------------|---------|
| All AC checked | `knowns task edit <id> --check-ac N` |
| Notes added | `knowns task edit <id> --notes "Summary"` |
| Timer stopped | `knowns time stop` |
| Status = done | `knowns task edit <id> -s done` |
| Tests pass | Run test suite |
{{/if}}

---

## Completion Steps

{{#if mcp}}
```json
// 1. Verify all AC are checked
mcp__knowns__get_task({ "taskId": "<id>" })

// 2. Add implementation notes
mcp__knowns__update_task({
  "taskId": "<id>",
  "notes": "## Summary\nWhat was done and key decisions."
})

// 3. Stop timer (REQUIRED!)
mcp__knowns__stop_time({ "taskId": "<id>" })

// 4. Mark done
mcp__knowns__update_task({
  "taskId": "<id>",
  "status": "done"
})
```
{{else}}
```bash
# 1. Verify all AC are checked
knowns task <id> --plain

# 2. Add implementation notes
knowns task edit <id> --notes $'## Summary
What was done and key decisions.'

# 3. Stop timer (REQUIRED!)
knowns time stop

# 4. Mark done
knowns task edit <id> -s done
```
{{/if}}

---

## Post-Completion Changes

If user requests changes after task is done:

{{#if mcp}}
```json
// 1. Reopen task
mcp__knowns__update_task({
  "taskId": "<id>",
  "status": "in-progress"
})

// 2. Restart timer
mcp__knowns__start_time({ "taskId": "<id>" })

// 3. Add AC for the fix
mcp__knowns__update_task({
  "taskId": "<id>",
  "addAc": ["Fix: description"],
  "appendNotes": "Reopened: reason"
})
```
{{else}}
```bash
knowns task edit <id> -s in-progress    # Reopen
knowns time start <id>                   # Restart timer
knowns task edit <id> --ac "Fix: description"
knowns task edit <id> --append-notes "Reopened: reason"
```
{{/if}}

Then follow completion steps again.

---

## Checklist

{{#if mcp}}
- [ ] All AC checked (`checkAc`)
- [ ] Notes added (`notes`)
- [ ] Timer stopped (`mcp__knowns__stop_time`)
- [ ] Tests pass
- [ ] Status = done (`mcp__knowns__update_task`)
{{else}}
- [ ] All AC checked (`--check-ac`)
- [ ] Notes added (`--notes`)
- [ ] Timer stopped (`time stop`)
- [ ] Tests pass
- [ ] Status = done (`-s done`)
{{/if}}
