# Task Completion Workflow

Guide for properly completing tasks.

---

## Definition of Done

A task is **Done** ONLY when **ALL** of the following are complete:

### ✅ Via CLI Commands

| Requirement | Command | Status |
|-------------|---------|--------|
| All AC checked | `knowns task edit <id> --check-ac N` | Required |
| Implementation notes added | `knowns task edit <id> --notes "..."` | Required |
| Timer stopped | `knowns time stop` | Required |
| Status set to done | `knowns task edit <id> -s done` | Required |

### ✅ Via Code/Testing

| Requirement | Action | Status |
|-------------|--------|--------|
| Tests pass | Run test suite | Required |
| No regressions | Verify existing functionality | Required |
| Docs updated | Update relevant documentation | If applicable |
| Code reviewed | Self-review changes | Required |

---

## Completion Steps

### Step 1: Verify All Acceptance Criteria

```bash
# View the task to check AC status
knowns task <id> --plain

# Ensure ALL criteria are checked
# If any are unchecked, complete the work first!
```

### Step 2: Add Implementation Notes

Write notes suitable for a PR description:

```bash
knowns task edit <id> --notes $'## Summary
Implemented JWT authentication using jsonwebtoken library.

## Changes
- Added auth middleware in src/middleware/auth.ts
- Added /login and /refresh endpoints
- Created JWT utility functions

## Tests
- Added 15 unit tests
- Coverage: 94%

## Notes
- Chose HS256 algorithm for simplicity
- Token expiry set to 1 hour as per requirements'
```

**Good notes include:**
- What was implemented
- Key decisions and why
- Files changed
- Test coverage
- Any follow-up needed

### Step 3: Stop Timer

```bash
knowns time stop
```

**⚠️ CRITICAL:** Never forget to stop the timer!

If you forgot to stop earlier, add manual entry:
```bash
knowns time add <id> 2h -n "Forgot to stop timer"
```

### Step 4: Mark as Done

```bash
knowns task edit <id> -s done
```

---

## Post-Completion Changes

If the user requests changes **AFTER** the task is marked done:

```bash
# 1. Reopen task
knowns task edit <id> -s in-progress

# 2. Restart timer
knowns time start <id>

# 3. Add AC for the changes
knowns task edit <id> --ac "Post-completion fix: description"

# 4. Document why reopened
knowns task edit <id> --append-notes "🔄 Reopened: User requested changes - reason"

# 5. Complete the work, then follow completion steps again
```

---

## Knowledge Extraction

After completing a task, consider if any knowledge should be documented:

```bash
# Search if similar pattern already documented
knowns search "pattern-name" --type doc --plain

# If new reusable knowledge, create doc
knowns doc create "Pattern: Name" \
  -d "Reusable pattern from task implementation" \
  -t "pattern" \
  -f "patterns"

# Reference source task
knowns doc edit "patterns/name" -a "Source: @task-<id>"
```

**Extract knowledge when:**
- New patterns/conventions discovered
- Common error solutions found
- Reusable code approaches identified
- Integration patterns documented

**Don't extract:**
- Task-specific details (those belong in implementation notes)
- One-off solutions

---

## Common Mistakes

### ❌ Marking done without all AC checked

```bash
# ❌ Wrong: AC not all checked
knowns task edit <id> -s done

# ✅ Right: Check all AC first
knowns task edit <id> --check-ac 1 --check-ac 2 --check-ac 3
knowns task edit <id> -s done
```

### ❌ Forgetting to stop timer

Timer keeps running! Always stop when done:
```bash
knowns time stop
```

### ❌ No implementation notes

Notes are required for PR description:
```bash
# ❌ Wrong: No notes
knowns task edit <id> -s done

# ✅ Right: Add notes first
knowns task edit <id> --notes "Summary of what was done"
knowns task edit <id> -s done
```

### ❌ Autonomously creating follow-up tasks

After completing work, **present** follow-up ideas to the user. Don't automatically create new tasks without permission.

---

## Completion Checklist

Before marking done, verify:

- [ ] All acceptance criteria are checked (`--check-ac`)
- [ ] Implementation notes are added (`--notes`)
- [ ] Implementation plan reflects final approach
- [ ] Tests pass without regressions
- [ ] Documentation updated if needed
- [ ] Timer stopped (`knowns time stop`)
- [ ] Status set to done (`-s done`)
