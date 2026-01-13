# Task Completion

## Definition of Done

A task is **Done** when ALL of these are complete:

| Requirement | Command |
|-------------|---------|
| All AC checked | `knowns task edit <id> --check-ac N` |
| Notes added | `knowns task edit <id> --notes "Summary"` |
| Timer stopped | `knowns time stop` |
| Status = done | `knowns task edit <id> -s done` |
| Tests pass | Run test suite |

---

## Completion Steps

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

---

## Post-Completion Changes

If user requests changes after task is done:

```bash
knowns task edit <id> -s in-progress    # Reopen
knowns time start <id>                   # Restart timer
knowns task edit <id> --ac "Fix: description"
knowns task edit <id> --append-notes "🔄 Reopened: reason"
# Complete work, then follow completion steps again
```

---

## Checklist

- [ ] All AC checked (`--check-ac`)
- [ ] Notes added (`--notes`)
- [ ] Timer stopped (`time stop`)
- [ ] Tests pass
- [ ] Status = done (`-s done`)
