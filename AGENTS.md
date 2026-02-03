<!-- KNOWNS GUIDELINES START -->
# Core Rules

> These rules are NON-NEGOTIABLE. Violating them leads to data corruption and lost work.

---

## The Golden Rule

**If you want to change ANYTHING in a task or doc, use CLI commands. NEVER edit .md files directly.**


---

## CRITICAL: The -a Flag Confusion

The `-a` flag means DIFFERENT things in different commands:

| Command | `-a` Means | NOT This! |
|---------|------------|-----------|
| `task create` | `--assignee` (assign user) | ~~acceptance criteria~~ |
| `task edit` | `--assignee` (assign user) | ~~acceptance criteria~~ |
| `doc edit` | `--append` (append content) | ~~assignee~~ |

### Acceptance Criteria: Use --ac

```bash
# WRONG: -a is assignee, NOT acceptance criteria!
knowns task edit 35 -a "- [ ] Criterion"    # Sets assignee to garbage!

# CORRECT: Use --ac for acceptance criteria
knowns task edit 35 --ac "Criterion one"
knowns task create "Title" --ac "Criterion one" --ac "Criterion two"
```

---

## Quick Reference

| Rule | Description |
|------|-------------|
| **CLI Only** | Use commands for ALL operations. NEVER edit .md files directly |
| **Docs First** | Read project docs BEFORE planning or coding |
| **Time Tracking** | Start timer when taking task, stop when done |
| **Plan Approval** | Share plan with user, WAIT for approval before coding |
| **Check AC After** | Only mark criteria done AFTER completing work |

---

## The --plain Flag

**ONLY for view/list/search commands (NOT create/edit):**

```bash
# CORRECT
knowns task <id> --plain
knowns task list --plain
knowns doc "path" --plain
knowns search "query" --plain

# WRONG (create/edit don't support --plain)
knowns task create "Title" --plain       # ERROR!
knowns task edit <id> -s done --plain    # ERROR!
```

---

## Reference System

Tasks, docs, and templates can reference each other:

| Type | Writing (Input) | Reading (Output) |
|------|-----------------|------------------|
| Task | `@task-<id>` | `@.knowns/tasks/task-<id>` |
| Doc | `@doc/<path>` | `@.knowns/docs/<path>.md` |
| Template | `@template/<name>` | `@.knowns/templates/<name>` |

**Always follow refs recursively** to gather complete context before planning.

---

## Subtasks

### CLI
```bash
knowns task create "Subtask title" --parent 48
```

**CRITICAL:** Use raw ID for `--parent`:
```bash
# CORRECT
knowns task create "Title" --parent 48

# WRONG
knowns task create "Title" --parent task-48
```

---

# Context Optimization

Optimize your context usage to work more efficiently within token limits.

---

## Output Format

```bash
# Verbose output
knowns task 42 --json

# Compact output (always use --plain)
knowns task 42 --plain
```

---

## Search Before Read

### CLI
```bash
# DON'T: Read all docs hoping to find info
knowns doc "doc1" --plain
knowns doc "doc2" --plain

# DO: Search first, then read only relevant docs
knowns search "authentication" --type doc --plain
knowns doc "security-patterns" --plain
```

---


## Reading Documents

### CLI
**ALWAYS use `--smart`** - auto-handles both small and large docs:

```bash
# DON'T: Read without --smart
knowns doc readme --plain

# DO: Always use --smart
knowns doc readme --plain --smart
# Small doc → full content
# Large doc → stats + TOC

# If large, read specific section:
knowns doc readme --plain --section 3
```

**Behavior:**
- **≤2000 tokens**: Returns full content automatically
- **>2000 tokens**: Returns stats + TOC, then use section parameter

---

## Compact Notes

```bash
# DON'T: Verbose notes
knowns task edit 42 --append-notes "I have successfully completed the implementation..."

# DO: Compact notes
knowns task edit 42 --append-notes "Done: Auth middleware + JWT validation"
```

---

## Avoid Redundant Operations

| Don't | Do Instead |
|-------|------------|
| Re-read files already in context | Reference from memory |
| List tasks/docs multiple times | List once, remember results |
| Quote entire file contents | Summarize key points |

---

## Efficient Workflow

| Phase | Context-Efficient Approach |
|-------|---------------------------|
| **Research** | Search → Read only matches |
| **Planning** | Brief plan, not detailed prose |
| **Coding** | Read only files being modified |
| **Notes** | Bullet points, not paragraphs |
| **Completion** | Summary, not full log |

---

## Quick Rules

1. **Always `--plain`** - Never use `--json` unless needed
2. **Always `--smart`** - Auto-handles doc size
3. **Search first** - Don't read all docs hoping to find info
4. **Read selectively** - Only fetch what you need
5. **Write concise** - Compact notes, not essays
6. **Don't repeat** - Reference context already loaded

---

# CLI Commands Reference

## task create

```bash
knowns task create <title> [options]
```

| Flag | Short | Purpose |
|------|-------|---------|
| `--description` | `-d` | Task description |
| `--ac` | | Acceptance criterion (repeatable) |
| `--labels` | `-l` | Comma-separated labels |
| `--assignee` | `-a` | Assign to user |
| `--priority` | | low/medium/high |
| `--parent` | | Parent task ID (raw ID only!) |

**`-a` = assignee, NOT acceptance criteria! Use `--ac` for AC.**

---

## task edit

```bash
knowns task edit <id> [options]
```

| Flag | Short | Purpose |
|------|-------|---------|
| `--status` | `-s` | Change status |
| `--assignee` | `-a` | Assign user |
| `--ac` | | Add acceptance criterion |
| `--check-ac` | | Mark AC done (1-indexed) |
| `--uncheck-ac` | | Unmark AC |
| `--plan` | | Set implementation plan |
| `--notes` | | Replace notes |
| `--append-notes` | | Add to notes |

---

## task view/list

```bash
knowns task <id> --plain
knowns task list --plain
knowns task list --status in-progress --plain
knowns task list --tree --plain
```

---

## doc create

```bash
knowns doc create <title> [options]
```

| Flag | Short | Purpose |
|------|-------|---------|
| `--description` | `-d` | Description |
| `--tags` | `-t` | Comma-separated tags |
| `--folder` | `-f` | Folder path |

---

## doc edit

```bash
knowns doc edit <name> [options]
```

| Flag | Short | Purpose |
|------|-------|---------|
| `--content` | `-c` | Replace content |
| `--append` | `-a` | Append content |
| `--section` | | Target section (use with -c) |

**In doc edit, `-a` = append content, NOT assignee!**

---

## doc view/list

**ALWAYS use `--smart`** - auto-handles small/large docs:

```bash
knowns doc <path> --plain --smart
```

If large, returns TOC. Then read section:
```bash
knowns doc <path> --plain --section 3
```

```bash
knowns doc list --plain
knowns doc list --tag api --plain
```

---

## time

```bash
knowns time start <id>    # REQUIRED when taking task
knowns time stop          # REQUIRED when completing
knowns time status
knowns time add <id> <duration> -n "Note"
```

---

## search

```bash
knowns search "query" --plain
knowns search "auth" --type task --plain
knowns search "api" --type doc --plain
```

---

## template

```bash
knowns template list
knowns template info <name>
knowns template run <name> --name "X" --dry-run
knowns template create <name>
```

---

## Multi-line Input

```bash
knowns task edit <id> --plan $'1. Step\n2. Step\n3. Step'
```

---

# Task Creation

## Before Creating

### CLI
```bash
# Search for existing tasks first
knowns search "keyword" --type task --plain
```

---

## Create Task

### CLI
```bash
knowns task create "Clear title (WHAT)" \
  -d "Description (WHY)" \
  --ac "Outcome 1" \
  --ac "Outcome 2" \
  --priority medium \
  -l "labels"
```

---

## Quality Guidelines

### Title
| Bad | Good |
|-----|------|
| Do auth stuff | Add JWT authentication |
| Fix bug | Fix login timeout |

### Description
Explain WHY. Include doc refs: `@doc/security-patterns`

### Acceptance Criteria
**Outcome-focused, NOT implementation steps:**

| Bad | Good |
|-----|------|
| Add handleLogin() function | User can login |
| Use bcrypt | Passwords are hashed |
| Add try-catch | Errors return proper HTTP codes |

---

## Subtasks

### CLI
```bash
knowns task create "Parent task"
knowns task create "Subtask" --parent 48  # Raw ID only!
```

---

## Anti-Patterns

- Too many AC in one task -> Split into multiple tasks
- Implementation steps as AC -> Write outcomes instead
- Skip search -> Always check existing tasks first

---

# Task Execution

## Step 1: Take Task

### CLI
```bash
knowns task edit <id> -s in-progress -a @me
knowns time start <id>    # REQUIRED!
```

---

## Step 2: Research

### CLI
```bash
# Read task and follow ALL refs
knowns task <id> --plain
# @doc/xxx → knowns doc "xxx" --plain
# @task-YY → knowns task YY --plain

# Search related docs
knowns search "keyword" --type doc --plain

# Check similar done tasks
knowns search "keyword" --type task --status done --plain
```

---

## Step 3: Plan (BEFORE coding!)

### CLI
```bash
knowns task edit <id> --plan $'1. Research (see @doc/xxx)
2. Implement
3. Test
4. Document'
```

**Share plan with user. WAIT for approval before coding.**

---

## Step 4: Implement

### CLI
```bash
# Check AC only AFTER work is done
knowns task edit <id> --check-ac 1
knowns task edit <id> --append-notes "Done: feature X"
```

---

## Scope Changes

If new requirements emerge during work:

### CLI
```bash
# Small: Add to current task
knowns task edit <id> --ac "New requirement"
knowns task edit <id> --append-notes "Scope updated: reason"

# Large: Ask user first, then create follow-up
knowns task create "Follow-up: feature" -d "From task <id>"
```

**Don't silently expand scope. Ask user first.**

---

## Key Rules

1. **Plan before code** - Capture approach first
2. **Wait for approval** - Don't start without OK
3. **Check AC after work** - Not before
4. **Ask on scope changes** - Don't expand silently

---

# Task Completion

## Definition of Done

A task is **Done** when ALL of these are complete:

### CLI
| Requirement | Command |
|-------------|---------|
| All AC checked | `knowns task edit <id> --check-ac N` |
| Notes added | `knowns task edit <id> --notes "Summary"` |
| Timer stopped | `knowns time stop` |
| Status = done | `knowns task edit <id> -s done` |
| Tests pass | Run test suite |

---

## Completion Steps

### CLI
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

### CLI
```bash
knowns task edit <id> -s in-progress    # Reopen
knowns time start <id>                   # Restart timer
knowns task edit <id> --ac "Fix: description"
knowns task edit <id> --append-notes "Reopened: reason"
```

Then follow completion steps again.

---

## Checklist

### CLI
- [ ] All AC checked (`--check-ac`)
- [ ] Notes added (`--notes`)
- [ ] Timer stopped (`time stop`)
- [ ] Tests pass
- [ ] Status = done (`-s done`)

---

# Common Mistakes

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

## CRITICAL: Notes vs Append Notes

**NEVER use `notes`/`--notes` for progress updates - it REPLACES all existing notes!**

```bash
# ❌ WRONG - Destroys audit trail!
knowns task edit <id> --notes "Done: feature X"

# ✅ CORRECT - Preserves history
knowns task edit <id> --append-notes "Done: feature X"
```

| Field | Behavior |
|-------|----------|
| `--notes` | **REPLACES** all notes (use only for initial setup) |
| `--append-notes` | **APPENDS** to existing notes (use for progress) |

---

## Quick Reference

| DON'T | DO |
|-------|-----|
| Edit .md files directly | Use CLI commands |
| `-a "criterion"` | `--ac "criterion"` |
| `--parent task-48` | `--parent 48` (raw ID) |
| `--plain` with create/edit | `--plain` only for view/list |
| `--notes` for progress | `--append-notes` for progress |
| Check AC before work done | Check AC AFTER work done |
| Code before plan approval | Wait for user approval |
| Code before reading docs | Read docs FIRST |
| Skip time tracking | Always start/stop timer |
| Ignore refs | Follow ALL `@task-xxx`, `@doc/xxx`, `@template/xxx` refs |


---

## Template Syntax Pitfalls

When writing `.hbs` templates, **NEVER** create `$` followed by triple-brace - Handlebars interprets triple-brace as unescaped output:

```
// ❌ WRONG - Parse error!
this.logger.log(`Created: $` + `{` + `{` + `{camelCase entity}.id}`);

// ✅ CORRECT - Add space between ${ and double-brace, use ~ to trim whitespace
this.logger.log(`Created: ${ {{~camelCase entity~}}.id}`);
```

| DON'T | DO |
|-------|-----|
| `$` + triple-brace | `${ {{~helper~}}}` (space + escaped) |

**Rules:**
- Add space between `${` and double-brace
- Use `~` (tilde) to trim whitespace in output
- Escape literal braces with backslash

---

## Error Recovery

| Problem | Solution |
|---------|----------|
| Set assignee to AC text | `knowns task edit <id> -a @me` |
| Forgot to stop timer | `knowns time add <id> <duration>` |
| Checked AC too early | `knowns task edit <id> --uncheck-ac N` |
| Task not found | `knowns task list --plain` |
| Replaced notes by mistake | Cannot recover - notes are lost. Use `--append-notes` next time |
<!-- KNOWNS GUIDELINES END -->