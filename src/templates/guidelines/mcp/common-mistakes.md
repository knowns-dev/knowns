# Common Mistakes (MCP)

## Quick Reference

| DON'T | DO |
|-------|-----|
| Edit .md files directly | Use MCP tools |
| Skip time tracking | Always `start_time`/`stop_time` |
| Check AC before work done | Check AC AFTER work done |
| Code before plan approval | Wait for user approval |
| Code before reading docs | Read docs FIRST |
| Ignore task refs | Follow ALL `@.knowns/...` refs |
| Use wrong task ID format | Use raw ID string |

---

## MCP vs CLI Usage

Some operations require CLI (not available in MCP):

| Operation | Tool |
|-----------|------|
| Add acceptance criteria | CLI: `--ac` |
| Check/uncheck AC | CLI: `--check-ac`, `--uncheck-ac` |
| Set implementation plan | CLI: `--plan` |
| Add/append notes | CLI: `--notes`, `--append-notes` |
| Create/update task basic fields | MCP tools |
| Time tracking | MCP tools |
| Read tasks/docs | MCP tools |
| Search | MCP tools |

---

## Error Recovery

| Problem | Solution |
|---------|----------|
| Forgot to stop timer | `mcp__knowns__add_time` with duration |
| Wrong status | `mcp__knowns__update_task` to fix |
| Task not found | `mcp__knowns__list_tasks` to find ID |
| Need to uncheck AC | CLI: `knowns task edit <id> --uncheck-ac N` |
