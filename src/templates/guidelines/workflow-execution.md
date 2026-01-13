# Task Execution

## Step 1: Take Task

```bash
knowns task edit <id> -s in-progress -a @me
knowns time start <id>    # REQUIRED!
```

---

## Step 2: Research

```bash
# Read task and follow ALL refs
knowns task <id> --plain
# @.knowns/docs/xxx.md → knowns doc "xxx" --plain
# @.knowns/tasks/task-YY → knowns task YY --plain

# Search related docs
knowns search "keyword" --type doc --plain

# Check similar done tasks
knowns search "keyword" --type task --status done --plain
```

---

## Step 3: Plan (BEFORE coding!)

```bash
knowns task edit <id> --plan $'1. Research (see @doc/xxx)
2. Implement
3. Test
4. Document'
```

**⚠️ Share plan with user. WAIT for approval before coding.**

---

## Step 4: Implement

```bash
# Check AC only AFTER work is done
knowns task edit <id> --check-ac 1
knowns task edit <id> --append-notes "✓ Done: feature X"
```

---

## Scope Changes

If new requirements emerge during work:

```bash
# Small: Add to current task
knowns task edit <id> --ac "New requirement"
knowns task edit <id> --append-notes "⚠️ Scope updated: reason"

# Large: Ask user first, then create follow-up
knowns task create "Follow-up: feature" -d "From task <id>"
```

**⚠️ Don't silently expand scope. Ask user first.**

---

## Key Rules

1. **Plan before code** - Capture approach first
2. **Wait for approval** - Don't start without OK
3. **Check AC after work** - Not before
4. **Ask on scope changes** - Don't expand silently
