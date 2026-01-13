# Common Mistakes

## ⚠️ CRITICAL: The -a Flag

| Command | `-a` Means | NOT This! |
|---------|------------|-----------|
| `task create/edit` | `--assignee` | ~~acceptance criteria~~ |
| `doc edit` | `--append` | ~~assignee~~ |

```bash
# ❌ WRONG (sets assignee to garbage!)
knowns task edit 35 -a "Criterion text"

# ✅ CORRECT (use --ac)
knowns task edit 35 --ac "Criterion text"
```

---

## Quick Reference

| ❌ DON'T | ✅ DO |
|----------|-------|
| Edit .md files directly | Use CLI commands |
| `-a "criterion"` | `--ac "criterion"` |
| `--parent task-48` | `--parent 48` (raw ID) |
| `--plain` with create/edit | `--plain` only for view/list |
| Check AC before work done | Check AC AFTER work done |
| Code before plan approval | Wait for user approval |
| Code before reading docs | Read docs FIRST |
| Skip time tracking | Always `time start`/`stop` |
| Ignore task refs | Follow ALL `@.knowns/...` refs |

---

## Error Recovery

| Problem | Solution |
|---------|----------|
| Set assignee to AC text | `knowns task edit <id> -a @me` |
| Forgot to stop timer | `knowns time add <id> <duration>` |
| Checked AC too early | `knowns task edit <id> --uncheck-ac N` |
| Task not found | `knowns task list --plain` |
