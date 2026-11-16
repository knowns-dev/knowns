# Task Completion

## Definition of Done

A task is **Done** when ALL of these are complete:

{{#if cli}}
### CLI
| Requirement | Command |
|-------------|---------|
| All AC checked | `knowns task edit <id> --check-ac N` |
| Notes added | `knowns task edit <id> --notes "Summary"` |
| Refs validated | `knowns validate` |
| Timer stopped | `knowns time stop` |
| Status = done | `knowns task edit <id> -s done` |
| Tests pass | Run test suite |
| Decision impact recorded | `System Decision Impact: none` or persisted candidate ref |
{{/if}}
{{#if mcp}}
### MCP
| Requirement | How |
|-------------|-----|
| All AC checked | `mcp__knowns__update_task` with `checkAc` |
| Notes added | `mcp__knowns__update_task` with `notes` |
| Refs validated | `mcp__knowns__validate` |
| Timer stopped | `mcp__knowns__stop_time` |
| Status = done | `mcp__knowns__update_task` with `status: "done"` |
| Tests pass | Run test suite |
| Decision impact recorded | `System Decision Impact: none` or persisted candidate ref |
{{/if}}

---

## System Decision Impact Gate

Before completing any task or spec workflow, ask:

> Did this verified work add, change, or remove durable project guidance future work must follow?

{{#if cli}}
- **No:** create no candidate and append `System Decision Impact: none — <reason>`.
- **Yes:** create a first-class draft candidate linked to the task, spec/doc, and readable source:

```bash
knowns decision create "<title>" \
  --task <task-id> \
  --doc <spec-or-doc-path> \
  --source @doc/<source-path> \
  --decision "<durable guidance>"
```

Then append `System Decision Impact: candidate @decision/<id> (added|changed|removed) — <summary>`.
{{/if}}
{{#if mcp}}
- **No:** create no candidate and append `System Decision Impact: none — <reason>`.
- **Yes:** create a first-class draft candidate:

```json
mcp__knowns__decision({
  "action": "create",
  "title": "<title>",
  "status": "draft",
  "decision": "<durable guidance>",
  "sources": ["@doc/<source-path>"],
  "relatedDocs": ["<spec-or-doc-path>"],
  "relatedTasks": ["<task-id>"]
})
```

Then append `System Decision Impact: candidate @decision/<id> (added|changed|removed) — <summary>`.
{{/if}}

Passing automated checks never auto-accepts the candidate. It remains non-current until explicit verified human review. Keep Spec Decisions canonical in the spec's `Locked Decisions`; never mirror them into the System Decision ledger. Never create Memory category `decision`; redirect legacy "Decision Memory" requests to the first-class candidate flow.

---

## Completion Steps

{{#if cli}}
### CLI
```bash
# 1. Verify all AC are checked
knowns task <id> --plain

# 2. Add implementation notes
knowns task edit <id> --notes $'## Summary
What was done and key decisions.'

# 3. Validate refs (catch broken @doc/ @task- refs)
knowns validate

# 4. Stop timer (REQUIRED!)
knowns time stop

# 5. Mark done
knowns task edit <id> -s done
```
{{/if}}
{{#if mcp}}
### MCP
```json
// 1. Verify all AC are checked
mcp__knowns__get_task({ "taskId": "<id>" })

// 2. Add implementation notes
mcp__knowns__update_task({
  "taskId": "<id>",
  "notes": "## Summary\nWhat was done and key decisions."
})

// 3. Validate refs (catch broken @doc/ @task- refs)
mcp__knowns__validate({})

// 4. Stop timer (REQUIRED!)
mcp__knowns__stop_time({ "taskId": "<id>" })

// 5. Mark done
mcp__knowns__update_task({
  "taskId": "<id>",
  "status": "done"
})
```
{{/if}}

---

## Post-Completion Changes

If user requests changes after task is done:

{{#if cli}}
### CLI
```bash
knowns task edit <id> -s in-progress    # Reopen
knowns time start <id>                   # Restart timer
knowns task edit <id> --ac "Fix: description"
knowns task edit <id> --append-notes "Reopened: reason"
```
{{/if}}
{{#if mcp}}
### MCP
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
{{/if}}

Then follow completion steps again.

---

## Checklist

{{#if cli}}
### CLI
- [ ] All AC checked (`--check-ac`)
- [ ] System Decision Impact marker recorded
- [ ] Notes added (`--notes`)
- [ ] Refs validated (`knowns validate`)
- [ ] Timer stopped (`time stop`)
- [ ] Tests pass
- [ ] Status = done (`-s done`)
{{/if}}
{{#if mcp}}
### MCP
- [ ] All AC checked (`checkAc`)
- [ ] System Decision Impact marker recorded
- [ ] Notes added (`notes`)
- [ ] Refs validated (`mcp__knowns__validate`)
- [ ] Timer stopped (`mcp__knowns__stop_time`)
- [ ] Tests pass
- [ ] Status = done (`mcp__knowns__update_task`)
{{/if}}
