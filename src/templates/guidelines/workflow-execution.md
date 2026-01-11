# Task Execution Workflow

Guide for implementing tasks effectively.

---

## Step 1: Take the Task

The **first things** you must do when taking a task:

```bash
# Set status to in-progress and assign to yourself
knowns task edit <id> -s in-progress -a @me

# Start time tracking (REQUIRED!)
knowns time start <id>
```

---

## Step 2: Research & Understand

Before planning, gather complete context:

```bash
# Read the task details
knowns task <id> --plain

# Follow ALL refs in the task
# @.knowns/docs/xxx.md → knowns doc "xxx" --plain
# @.knowns/tasks/task-YY → knowns task YY --plain

# Search for related documentation
knowns search "keyword" --type doc --plain

# Check similar completed tasks for patterns
knowns search "keyword" --type task --status done --plain
```

**Why?** Understanding existing patterns prevents reinventing the wheel.

---

## Step 3: Create Implementation Plan

Capture your plan in the task **BEFORE writing any code**.

```bash
knowns task edit <id> --plan $'1. Research existing patterns (see @doc/xxx)
2. Design approach
3. Implement core functionality
4. Add tests
5. Update documentation'
```

### ⚠️ CRITICAL: Wait for Approval

**Share the plan with the user and WAIT for explicit approval before coding.**

Do not begin implementation until:
- User approves the plan, OR
- User explicitly tells you to skip review

---

## Step 4: Implement

Work through your plan step by step:

### Document Progress

```bash
# After completing each significant piece of work
knowns task edit <id> --append-notes "✓ Completed: research phase"
knowns task edit <id> --append-notes "✓ Completed: core implementation"
```

### Check Acceptance Criteria

Only mark AC as done **AFTER** the work is actually complete:

```bash
# After completing work for AC #1
knowns task edit <id> --check-ac 1

# After completing work for AC #2
knowns task edit <id> --check-ac 2
```

**⚠️ CRITICAL:** Never check AC before the work is done. ACs represent completed outcomes.

---

## Scope Management

### When New Requirements Emerge

If you discover additional work needed during implementation:

**Option 1: Add to current task (if small)**
```bash
knowns task edit <id> --ac "New requirement discovered"
knowns task edit <id> --append-notes "⚠️ Scope updated: Added requirement for X"
```

**Option 2: Create follow-up task (if significant)**
```bash
knowns task create "Follow-up: Additional feature" -d "Discovered during task <id>"
knowns task edit <id> --append-notes "📝 Created follow-up task for X"
```

**⚠️ CRITICAL:** Stop and ask the user which option to use. Don't silently expand scope.

---

## Plan Updates

If your approach changes during implementation, update the plan:

```bash
knowns task edit <id> --plan $'1. [DONE] Research
2. [DONE] Original approach
3. [CHANGED] New approach due to X
4. Remaining work'
```

The plan should remain the **single source of truth** for how the task was solved.

---

## Handling Subtasks

### When Assigned "Parent and All Subtasks"

Proceed sequentially without asking permission between each subtask:

1. Complete subtask 1
2. Complete subtask 2
3. Continue until all done

### When Assigned Single Subtask

Present progress and request guidance before advancing to the next subtask.

---

## Key Principles

1. **Plan before code** - Always capture approach before implementation
2. **Document decisions** - Record why you chose certain approaches
3. **Update on changes** - Keep plan current if approach shifts
4. **Ask on scope** - Don't silently expand work
5. **Check AC after work** - Only mark done when truly complete
