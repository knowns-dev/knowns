---
name: knowns.task
description: Use when working on a Knowns task - take ownership, research, plan, implement, complete with proper tracking
---

# Working on a Knowns Task

Execute the complete task workflow with proper documentation reading, planning, and time tracking.

**Announce at start:** "I'm using the knowns.task skill to work on task [ID]."

**Core principle:** NO IMPLEMENTATION WITHOUT RESEARCH AND APPROVED PLAN FIRST.

## The Process

### Phase 1: Take Ownership

```bash
# View task details
knowns task $ARGUMENTS --plain

# Take task and start timer
knowns task edit $ARGUMENTS -s in-progress -a @me
knowns time start $ARGUMENTS
```

**Timer is mandatory.** Time tracking data informs project estimation and identifies bottlenecks.

### Phase 2: Research (MANDATORY)

**Follow ALL refs in task output:**
- `@task-<id>` → `knowns task <id> --plain`
- `@doc/<path>` → `knowns doc "<path>" --plain --smart`

```bash
# Search related docs
knowns search "<keywords>" --type doc --plain

# Check similar completed tasks (learn from history)
knowns search "<keywords>" --type task --status done --plain
```

**Why research matters:**
- Prevents reinventing existing patterns
- Ensures consistency with project conventions
- Reveals reusable code/utilities
- Identifies potential blockers early

### Phase 3: Plan (WAIT FOR APPROVAL)

```bash
knowns task edit $ARGUMENTS --plan $'1. Step one (see @doc/relevant-doc)
2. Step two
3. Add tests
4. Update documentation'
```

**Present plan to user and WAIT.** Do not proceed until explicit approval.

If using brainstorm first:
- **RELATED SKILL:** Use knowns.task.brainstorm for complex requirements

### Phase 4: Implement

For each piece of work completed:

```bash
# Check AC only AFTER work is done
knowns task edit $ARGUMENTS --check-ac 1
knowns task edit $ARGUMENTS --append-notes "✓ Done: brief description"
```

**Red flags - you're doing it wrong if:**
- Checking AC before work is actually complete
- Making changes not in the approved plan
- Skipping tests

**If scope changes during implementation:**
1. Stop and ask user
2. Add new AC: `knowns task edit $ARGUMENTS --ac "New requirement"`
3. Update plan if needed

### Phase 5: Complete

```bash
# Add implementation summary
knowns task edit $ARGUMENTS --notes $'## Summary
What was done and key decisions.

## Changes
- Change 1
- Change 2'

# Stop timer (REQUIRED!)
knowns time stop

# Mark done
knowns task edit $ARGUMENTS -s done
```

## When to Stop and Ask

**STOP immediately when:**
- Requirements are unclear or contradictory
- You hit a blocker not addressed in the plan
- The approach isn't working after 2-3 attempts
- You need to make changes outside approved scope

**Ask for clarification rather than guessing.**

## Common Mistakes

| Wrong | Right |
|-------|-------|
| Check AC before work done | Check AC only AFTER completing |
| Skip research phase | Always read related docs first |
| Start coding before plan approval | Wait for explicit approval |
| Forget to stop timer | Always `knowns time stop` |
| Use `-a` for acceptance criteria | Use `--ac` (not `-a`) |

## Remember

- Research before planning
- Plan before implementing
- Check AC after completing (not before)
- Timer is mandatory
- Ask when blocked, don't guess
