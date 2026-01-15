# Task Completion (MCP)

## Definition of Done

A task is **Done** when ALL of these are complete:

| Requirement | How |
|-------------|-----|
| All AC checked | CLI: `knowns task edit <id> --check-ac N` |
| Notes added | CLI: `knowns task edit <id> --notes "Summary"` |
| Timer stopped | MCP: `mcp__knowns__stop_time` |
| Status = done | MCP: `mcp__knowns__update_task` |
| Tests pass | Run test suite |

---

## Completion Steps

```json
// 1. Verify all AC are checked
mcp__knowns__get_task({ "taskId": "abc123" })
```

```bash
# 2. Add implementation notes (use CLI)
knowns task edit abc123 --notes $'## Summary
What was done and key decisions.'
```

```json
// 3. Stop timer (REQUIRED!)
mcp__knowns__stop_time({ "taskId": "abc123" })

// 4. Mark done
mcp__knowns__update_task({
  "taskId": "abc123",
  "status": "done"
})
```

---

## Post-Completion Changes

If user requests changes after task is done:

```json
// 1. Reopen task
mcp__knowns__update_task({
  "taskId": "abc123",
  "status": "in-progress"
})

// 2. Restart timer
mcp__knowns__start_time({ "taskId": "abc123" })
```

```bash
# 3. Add AC for the fix
knowns task edit abc123 --ac "Fix: description"
knowns task edit abc123 --append-notes "Reopened: reason"
```

Then follow completion steps again.

---

## Checklist

- [ ] All AC checked (CLI `--check-ac`)
- [ ] Notes added (CLI `--notes`)
- [ ] Timer stopped (`mcp__knowns__stop_time`)
- [ ] Tests pass
- [ ] Status = done (`mcp__knowns__update_task`)
