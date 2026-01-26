# Common Mistakes

{{#unless mcp}}
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
{{/unless}}

## Quick Reference

| DON'T | DO |
|-------|-----|
{{#if mcp}}
| Edit .md files directly | Use MCP tools |
{{else}}
| Edit .md files directly | Use CLI commands |
| `-a "criterion"` | `--ac "criterion"` |
| `--parent task-48` | `--parent 48` (raw ID) |
| `--plain` with create/edit | `--plain` only for view/list |
{{/if}}
| Check AC before work done | Check AC AFTER work done |
| Code before plan approval | Wait for user approval |
| Code before reading docs | Read docs FIRST |
| Skip time tracking | Always start/stop timer |
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
{{#if mcp}}
| Forgot to stop timer | `mcp__knowns__add_time` with duration |
| Wrong status | `mcp__knowns__update_task` to fix |
| Task not found | `mcp__knowns__list_tasks` to find ID |
| Need to uncheck AC | `mcp__knowns__update_task` with `uncheckAc: [N]` |
| Checked AC too early | `mcp__knowns__update_task` with `uncheckAc: [N]` |
{{else}}
| Set assignee to AC text | `knowns task edit <id> -a @me` |
| Forgot to stop timer | `knowns time add <id> <duration>` |
| Checked AC too early | `knowns task edit <id> --uncheck-ac N` |
| Task not found | `knowns task list --plain` |
{{/if}}
