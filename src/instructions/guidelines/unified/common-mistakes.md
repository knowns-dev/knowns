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

## MCP vs CLI Usage

Some operations require CLI:

| Operation | Tool |
|-----------|------|
| Add acceptance criteria | CLI: `--ac` |
| Check/uncheck AC | CLI: `--check-ac` |
| Set implementation plan | CLI: `--plan` |
| Add/append notes | CLI: `--notes`, `--append-notes` |
| Basic task fields | MCP tools |
| Time tracking | MCP tools |
| Read tasks/docs | MCP tools |
{{/if}}

---

## Error Recovery

| Problem | Solution |
|---------|----------|
{{#if mcp}}
| Forgot to stop timer | `mcp__knowns__add_time` with duration |
| Wrong status | `mcp__knowns__update_task` to fix |
| Task not found | `mcp__knowns__list_tasks` to find ID |
| Need to uncheck AC | CLI: `knowns task edit <id> --uncheck-ac N` |
{{else}}
| Set assignee to AC text | `knowns task edit <id> -a @me` |
| Forgot to stop timer | `knowns time add <id> <duration>` |
| Checked AC too early | `knowns task edit <id> --uncheck-ac N` |
| Task not found | `knowns task list --plain` |
{{/if}}
