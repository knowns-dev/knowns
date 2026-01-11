# Common Mistakes

Anti-patterns and common errors to avoid.

---

## ⚠️ CRITICAL: Flag Confusion

### The -a Flag Means Different Things!

| Command | `-a` Flag Means | NOT This! |
|---------|-----------------|-----------|
| `task create` | `--assignee` (assign user) | ~~acceptance criteria~~ |
| `task edit` | `--assignee` (assign user) | ~~acceptance criteria~~ |
| `doc edit` | `--append` (append content) | ~~assignee~~ |

### ❌ WRONG: Using -a for Acceptance Criteria

```bash
# ❌ WRONG: -a is assignee, sets assignee to garbage text!
knowns task edit 35 -a "- [ ] Criterion"
knowns task edit 35 -a "User can login"
knowns task create "Title" -a "Criterion text"
```

### ✅ CORRECT: Using --ac for Acceptance Criteria

```bash
# ✅ CORRECT: Use --ac for acceptance criteria
knowns task edit 35 --ac "Criterion one"
knowns task edit 35 --ac "Criterion two"
knowns task create "Title" --ac "Criterion one" --ac "Criterion two"
```

---

## Quick Reference: DO vs DON'T

### File Operations

| ❌ DON'T | ✅ DO |
|----------|-------|
| Edit .md files directly | Use CLI commands |
| Change `- [ ]` to `- [x]` in file | `--check-ac <index>` |
| Add notes directly to file | `--notes` or `--append-notes` |
| Edit frontmatter manually | Use CLI flags |

### Task Operations

| ❌ DON'T | ✅ DO |
|----------|-------|
| `-a "criterion"` (assignee!) | `--ac "criterion"` |
| `--parent task-48` | `--parent 48` (raw ID) |
| Skip time tracking | Always `time start`/`time stop` |
| Check AC before work done | Check AC AFTER completing work |
| Code before plan approval | Wait for user approval |
| Code before reading docs | Read ALL related docs first |

### Flag Usage

| ❌ DON'T | ✅ DO |
|----------|-------|
| `--plain` with create | `--plain` only for view/list/search |
| `--plain` with edit | `--plain` only for view/list/search |
| `--criteria "text"` | `--ac "text"` |
| `-ac "text"` | `--ac "text"` (two dashes!) |

---

## Detailed Mistakes

### 1. Direct File Editing

```markdown
# ❌ DON'T DO THIS:
1. Open backlog/tasks/task-7.md in editor
2. Change "- [ ]" to "- [x]" manually
3. Add notes directly to the file
4. Save the file

# ✅ DO THIS INSTEAD:
knowns task edit 7 --check-ac 1
knowns task edit 7 --notes "Implementation complete"
```

**Why?** Direct editing breaks:
- Metadata synchronization
- Git tracking
- Task relationships

### 2. Wrong Flag for Acceptance Criteria

```bash
# ❌ WRONG: All these set assignee, NOT acceptance criteria
knowns task edit 35 -a "Criterion"
knowns task create "Title" -a "AC text"
knowns task edit 35 --assignee "Criterion"  # Still wrong!

# ✅ CORRECT: Use --ac
knowns task edit 35 --ac "Criterion"
knowns task create "Title" --ac "AC text"
```

### 3. Wrong Task ID Format for Parent

```bash
# ❌ WRONG: Don't prefix with "task-"
knowns task create "Title" --parent task-48
knowns task edit 35 --parent task-48

# ✅ CORRECT: Use raw ID only
knowns task create "Title" --parent 48
knowns task edit 35 --parent qkh5ne
```

### 4. Using --plain with Create/Edit

```bash
# ❌ WRONG: create/edit don't support --plain
knowns task create "Title" --plain       # ERROR!
knowns task edit 35 -s done --plain      # ERROR!
knowns doc create "Title" --plain        # ERROR!
knowns doc edit "name" -c "..." --plain  # ERROR!

# ✅ CORRECT: --plain only for view/list/search
knowns task 35 --plain                   # OK
knowns task list --plain                 # OK
knowns doc "readme" --plain              # OK
knowns search "query" --plain            # OK
```

### 5. Skipping Time Tracking

```bash
# ❌ WRONG: No timer
knowns task edit 35 -s in-progress
# ... work ...
knowns task edit 35 -s done

# ✅ CORRECT: Always track time
knowns task edit 35 -s in-progress -a @me
knowns time start 35
# ... work ...
knowns time stop
knowns task edit 35 -s done
```

### 6. Checking AC Before Work is Done

```bash
# ❌ WRONG: Checking AC as a TODO list
knowns task edit 35 --check-ac 1  # Haven't done the work yet!
# ... then do the work ...

# ✅ CORRECT: Check AC AFTER completing work
# ... do the work first ...
knowns task edit 35 --check-ac 1  # Now it's actually done
```

### 7. Coding Before Plan Approval

```bash
# ❌ WRONG: Start coding immediately
knowns task edit 35 -s in-progress
knowns task edit 35 --plan "1. Do X\n2. Do Y"
# Immediately starts coding...

# ✅ CORRECT: Wait for approval
knowns task edit 35 -s in-progress
knowns task edit 35 --plan "1. Do X\n2. Do Y"
# STOP! Present plan to user
# Wait for explicit approval
# Then start coding
```

### 8. Ignoring Task References

```bash
# ❌ WRONG: Don't read refs
knowns task 35 --plain
# See "@.knowns/docs/api.md" but don't read it
# Start implementing without context...

# ✅ CORRECT: Follow ALL refs
knowns task 35 --plain
# See "@.knowns/docs/api.md"
knowns doc "api" --plain  # Read it!
# See "@.knowns/tasks/task-30"
knowns task 30 --plain    # Read it!
# Now have full context
```

---

## Error Recovery

| Problem | Solution |
|---------|----------|
| Set assignee to AC text by mistake | `knowns task edit <id> -a @me` to fix |
| Forgot to stop timer | `knowns time add <id> <duration> -n "Forgot to stop"` |
| Checked AC too early | `knowns task edit <id> --uncheck-ac <index>` |
| Task not found | `knowns task list --plain` to find correct ID |
| AC index out of range | `knowns task <id> --plain` to see AC numbers |
