# Common Mistakes

{{#if cli}}
## CRITICAL: The -a Flag

| Command | `-a` Means | NOT This! |
|---------|------------|-----------|
| `task create/edit` | `--assignee` | ~~acceptance criteria~~ |
| `doc edit` | `--append` | ~~assignee~~ |

```bash
# WRONG (sets assignee to garbage!)
knowns task edit 35 -a "Criterion text"

# CORRECT (use --ac)
knowns task edit 35 --ac "Criterion text"
```

---
{{/if}}

## CRITICAL: Notes vs Append Notes

**NEVER use `notes`/`--notes` for progress updates - it REPLACES all existing notes!**

{{#if cli}}
```bash
# ❌ WRONG - Destroys audit trail!
knowns task edit <id> --notes "Done: feature X"

# ✅ CORRECT - Preserves history
knowns task edit <id> --append-notes "Done: feature X"
```
{{/if}}
{{#if mcp}}
```json
// ❌ WRONG - Destroys audit trail!
mcp__knowns__update_task({
  "taskId": "<id>",
  "notes": "Done: feature X"
})

// ✅ CORRECT - Preserves history
mcp__knowns__update_task({
  "taskId": "<id>",
  "appendNotes": "Done: feature X"
})
```
{{/if}}

| Field | Behavior |
|-------|----------|
{{#if cli}}
| `--notes` | **REPLACES** all notes (use only for initial setup) |
| `--append-notes` | **APPENDS** to existing notes (use for progress) |
{{/if}}
{{#if mcp}}
| `notes` | **REPLACES** all notes (use only for initial setup) |
| `appendNotes` | **APPENDS** to existing notes (use for progress) |
{{/if}}

---

## Quick Reference

| DON'T | DO |
|-------|-----|
{{#if cli}}
| Edit .md files directly | Use CLI commands |
| `-a "criterion"` | `--ac "criterion"` |
| `--parent task-48` | `--parent 48` (raw ID) |
| `--plain` with create/edit | `--plain` only for view/list |
| `--notes` for progress | `--append-notes` for progress |
{{/if}}
{{#if mcp}}
| Edit .md files directly | Use MCP tools |
| `notes` for progress | `appendNotes` for progress |
{{/if}}
| Check AC before work done | Check AC AFTER work done |
| Code before plan approval | Wait for user approval |
| Code before reading docs | Read docs FIRST |
| Skip time tracking | Always start/stop timer |
| Skip validation | Run validate before completing |
| Ignore refs | Follow ALL `@task-xxx`, `@doc/xxx`, `@template/xxx` refs |

{{#if mcp}}
---

## MCP Task Operations

All task operations are available via MCP:

| Operation | MCP Field |
|-----------|-----------|
| Add acceptance criteria | `addAc: ["criterion"]` |
| Check AC | `checkAc: [1, 2]` (1-based) |
| Uncheck AC | `uncheckAc: [1]` (1-based) |
| Remove AC | `removeAc: [1]` (1-based) |
| Set plan | `plan: "..."` |
| Set notes | `notes: "..."` |
| Append notes | `appendNotes: "..."` |
| Change status | `status: "in-progress"` |
| Assign | `assignee: "@me"` |
{{/if}}

---

## Template Syntax Pitfalls

When writing `.hbs` templates, **NEVER** create `$` followed by triple-brace - Handlebars interprets triple-brace as unescaped output:

```
// ❌ WRONG - Parse error!
this.logger.log(`Created: $` + `{` + `{` + `{camelCase entity}.id}`);

// ✅ CORRECT - Add space between ${ and double-brace, use ~ to trim whitespace
this.logger.log(`Created: ${ \{{~camelCase entity~}}.id}`);
```

| DON'T | DO |
|-------|-----|
| `$` + triple-brace | `${ \{{~helper~}}}` (space + escaped) |

**Rules:**
- Add space between `${` and double-brace
- Use `~` (tilde) to trim whitespace in output
- Escape literal braces with backslash

---

## Error Recovery

| Problem | Solution |
|---------|----------|
{{#if cli}}
| Set assignee to AC text | `knowns task edit <id> -a @me` |
| Forgot to stop timer | `knowns time add <id> <duration>` |
| Checked AC too early | `knowns task edit <id> --uncheck-ac N` |
| Task not found | `knowns task list --plain` |
| Replaced notes by mistake | Cannot recover - notes are lost. Use `--append-notes` next time |
| Broken refs in task/doc | Run `knowns validate`, fix refs, validate again |
{{/if}}
{{#if mcp}}
| Forgot to stop timer | `mcp__knowns__add_time` with duration |
| Wrong status | `mcp__knowns__update_task` to fix |
| Task not found | `mcp__knowns__list_tasks` to find ID |
| Need to uncheck AC | `mcp__knowns__update_task` with `uncheckAc: [N]` |
| Checked AC too early | `mcp__knowns__update_task` with `uncheckAc: [N]` |
| Replaced notes by mistake | Cannot recover - notes are lost. Use `appendNotes` next time |
| Broken refs in task/doc | Run `mcp__knowns__validate`, fix refs, validate again |
{{/if}}
