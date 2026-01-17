<!-- KNOWNS GUIDELINES START -->
# Core Rules

You MUST follow these rules. If you cannot follow any rule, stop and ask for guidance before proceeding.

---

## 🎯 The Golden Rule

**If you want to change ANYTHING in a task or doc, use CLI commands or MCP tools. NEVER edit .md files directly.**

Why? Direct file editing breaks metadata synchronization, Git tracking, and relationships.

---

## ⚠️ CRITICAL: The -a Flag Confusion

The `-a` flag means DIFFERENT things in different commands:

| Command | `-a` Means | NOT This! |
|---------|------------|-----------|
| `task create` | `--assignee` (assign user) | ~~acceptance criteria~~ |
| `task edit` | `--assignee` (assign user) | ~~acceptance criteria~~ |
| `doc edit` | `--append` (append content) | ~~assignee~~ |

### Acceptance Criteria: Use --ac

```bash
# ❌ WRONG: -a is assignee, NOT acceptance criteria!
knowns task edit 35 -a "- [ ] Criterion"    # Sets assignee to garbage!
knowns task create "Title" -a "Criterion"   # Sets assignee to garbage!

# ✅ CORRECT: Use --ac for acceptance criteria
knowns task edit 35 --ac "Criterion one"
knowns task edit 35 --ac "Criterion two"
knowns task create "Title" --ac "Criterion one" --ac "Criterion two"
```

---

## Core Principles

| Rule | Description |
|------|-------------|
| **CLI/MCP Only** | Use commands for ALL operations. NEVER edit .md files directly |
| **Docs First** | Read project docs BEFORE planning or coding |
| **Time Tracking** | Always start timer when taking task, stop when done |
| **Plan Approval** | Share plan with user, WAIT for approval before coding |
| **Check AC After Work** | Only mark acceptance criteria done AFTER completing the work |

---

## The --plain Flag

**ONLY for view/list/search commands (NOT create/edit):**

```bash
# ✅ CORRECT
knowns task <id> --plain
knowns task list --plain
knowns doc "path" --plain
knowns doc list --plain
knowns search "query" --plain

# ❌ WRONG (create/edit don't support --plain)
knowns task create "Title" --plain       # ERROR!
knowns task edit <id> -s done --plain    # ERROR!
knowns doc create "Title" --plain        # ERROR!
knowns doc edit "name" -c "..." --plain  # ERROR!
```

---

## Reference System

| Type | Format | Example |
|------|--------|---------|
| **Task ref** | `@task-<id>` | `@task-pdyd2e` |
| **Doc ref** | `@doc/<path>` | `@doc/patterns/auth` |

Follow refs recursively until complete context gathered.

---

## Task IDs

| Format | Example | Notes |
|--------|---------|-------|
| Sequential | `48`, `49` | Legacy numeric |
| Hierarchical | `48.1`, `48.2` | Legacy subtasks |
| Random | `qkh5ne` | Current (6-char) |

**CRITICAL:** Use raw ID for `--parent`:
```bash
# ✅ CORRECT
knowns task create "Title" --parent 48

# ❌ WRONG
knowns task create "Title" --parent task-48
```

---

## Status & Priority

| Status | When |
|--------|------|
| `todo` | Not started (default) |
| `in-progress` | Currently working |
| `in-review` | PR submitted |
| `blocked` | Waiting on dependency |
| `done` | All criteria met |

| Priority | Level |
|----------|-------|
| `low` | Nice-to-have |
| `medium` | Normal (default) |
| `high` | Urgent |

---

# Context Optimization

Optimize your context usage to work more efficiently within token limits.

---

## Output Format

```bash
# ❌ Verbose output
knowns task 42 --json

# ✅ Compact output (always use --plain)
knowns task 42 --plain
```

---

## Search Before Read

```bash
# ❌ Reading all docs to find info
knowns doc "doc1" --plain
knowns doc "doc2" --plain
knowns doc "doc3" --plain

# ✅ Search first, then read only relevant docs
knowns search "authentication" --type doc --plain
knowns doc "security-patterns" --plain  # Only the relevant one
```

---

## Selective File Reading

```bash
# ❌ Reading entire large file
Read file (2000+ lines)

# ✅ Read specific sections
Read file with offset=100 limit=50
```

---

## Reading Documents (--smart)

**ALWAYS use `--smart` when reading documents.** It automatically handles both small and large docs:

```bash
# ❌ Reading without --smart (may get truncated large doc)
knowns doc readme --plain

# ✅ Always use --smart
knowns doc readme --plain --smart
# Small doc → returns full content
# Large doc → returns stats + TOC

# ✅ If doc is large, read specific section:
knowns doc readme --plain --section 3
```

**`--smart` behavior:**

- **≤2000 tokens**: Returns full content automatically
- **>2000 tokens**: Returns stats + TOC, then use `--section <number>`

---

## Compact Notes

```bash
# ❌ Verbose notes
knowns task edit 42 --append-notes "I have successfully completed the implementation of the authentication middleware which validates JWT tokens and handles refresh logic..."

# ✅ Compact notes
knowns task edit 42 --append-notes "✓ Auth middleware + JWT validation done"
```

---

## Avoid Redundant Operations

| Don't                            | Do Instead                  |
| -------------------------------- | --------------------------- |
| Re-read files already in context | Reference from memory       |
| List tasks/docs multiple times   | List once, remember results |
| Quote entire file contents       | Summarize key points        |
| Repeat full error messages       | Reference error briefly     |

---

## Efficient Workflow

| Phase          | Context-Efficient Approach     |
| -------------- | ------------------------------ |
| **Research**   | Search → Read only matches     |
| **Planning**   | Brief plan, not detailed prose |
| **Coding**     | Read only files being modified |
| **Notes**      | Bullet points, not paragraphs  |
| **Completion** | Summary, not full log          |

---

## Quick Rules

1. **Always `--plain`** - Never use `--json` unless specifically needed
2. **Always `--smart`** - Use `--smart` when reading docs (auto-handles size)
3. **Search first** - Don't read all docs hoping to find info
4. **Read selectively** - Use offset/limit for large files
5. **Write concise** - Compact notes, not essays
6. **Don't repeat** - Reference context already loaded
7. **Summarize** - Key points, not full quotes

---

# Commands Reference

## task create

```bash
knowns task create <title> [options]
```

| Flag            | Short | Purpose                           |
| --------------- | ----- | --------------------------------- |
| `--description` | `-d`  | Task description                  |
| `--ac`          |       | Acceptance criterion (repeatable) |
| `--labels`      | `-l`  | Comma-separated labels            |
| `--assignee`    | `-a`  | Assign to user ⚠️                 |
| `--priority`    |       | low/medium/high                   |
| `--status`      | `-s`  | Initial status                    |
| `--parent`      |       | Parent task ID (raw ID only!)     |

**⚠️ `-a` = assignee, NOT acceptance criteria! Use `--ac` for AC.**

---

## task edit

```bash
knowns task edit <id> [options]
```

| Flag             | Short | Purpose                  |
| ---------------- | ----- | ------------------------ |
| `--title`        | `-t`  | Change title             |
| `--description`  | `-d`  | Change description       |
| `--status`       | `-s`  | Change status            |
| `--priority`     |       | Change priority          |
| `--labels`       | `-l`  | Set labels               |
| `--assignee`     | `-a`  | Assign user ⚠️           |
| `--parent`       |       | Move to parent           |
| `--ac`           |       | Add acceptance criterion |
| `--check-ac`     |       | Mark AC done (1-indexed) |
| `--uncheck-ac`   |       | Unmark AC (1-indexed)    |
| `--remove-ac`    |       | Delete AC (1-indexed)    |
| `--plan`         |       | Set implementation plan  |
| `--notes`        |       | Replace notes            |
| `--append-notes` |       | Add to notes             |

**⚠️ `-a` = assignee, NOT acceptance criteria! Use `--ac` for AC.**

---

## task view/list

```bash
knowns task <id> --plain              # View single task
knowns task list --plain              # List all
knowns task list --status in-progress --plain
knowns task list --assignee @me --plain
knowns task list --tree --plain       # Tree hierarchy
```

---

## doc create

```bash
knowns doc create <title> [options]
```

| Flag            | Short | Purpose              |
| --------------- | ----- | -------------------- |
| `--description` | `-d`  | Description          |
| `--tags`        | `-t`  | Comma-separated tags |
| `--folder`      | `-f`  | Folder path          |

### Document Structure Best Practice

When creating/editing docs, use clear heading structure for `--toc` and `--section` to work properly:

```markdown
# Main Title (H1 - only one)

## 1. Overview

Brief introduction...

## 2. Installation

Step-by-step guide...

## 3. Configuration

### 3.1 Basic Config

...

### 3.2 Advanced Config

...

## 4. API Reference

...
```

**Writing rules:**

- Use numbered headings (`## 1. Overview`) for easy `--section "1"` access
- Keep H1 for title only, use H2 for main sections
- Use H3 for subsections within H2
- Each section should be self-contained (readable without context)

**Reading workflow:**

```bash
# Always use --smart (handles both small and large docs automatically)
knowns doc <path> --plain --smart

# If doc is large, --smart returns TOC, then read specific section:
knowns doc <path> --plain --section "2"
```

---

## doc edit

```bash
knowns doc edit <name> [options]
```

| Flag             | Short | Purpose                                   |
| ---------------- | ----- | ----------------------------------------- |
| `--title`        | `-t`  | Change title                              |
| `--description`  | `-d`  | Change description                        |
| `--tags`         |       | Set tags                                  |
| `--content`      | `-c`  | Replace content (or section if --section) |
| `--append`       | `-a`  | Append content ⚠️                         |
| `--section`      |       | Target section to replace (use with -c)   |
| `--content-file` |       | Content from file                         |
| `--append-file`  |       | Append from file                          |

**⚠️ In doc edit, `-a` = append content, NOT assignee!**

### Section Edit (Context-Efficient)

Replace only a specific section instead of entire document:

```bash
# Step 1: View TOC to find section
knowns doc readme --toc --plain

# Step 2: Edit only that section
knowns doc edit readme --section "2. Installation" -c "New content here..."
knowns doc edit readme --section "2" -c "New content..."  # By number works too
```

This reduces context usage significantly - no need to read/write entire document.

---

## doc view/list

```bash
knowns doc <path> --plain             # View single doc
knowns doc list --plain               # List all
knowns doc list --tag api --plain     # Filter by tag
```

### Reading Documents (--smart)

**ALWAYS use `--smart` when reading documents.** It automatically handles both small and large docs:

```bash
# Always use --smart (recommended)
knowns doc <path> --plain --smart
```

**Behavior:**

- **Small doc (≤2000 tokens)**: Returns full content automatically
- **Large doc (>2000 tokens)**: Returns stats + TOC, then use `--section` to read specific parts

```bash
# Example with large doc:
knowns doc readme --plain --smart
# Output: Size: ~12,132 tokens | TOC with numbered sections
# Hint: Use --section <number> to read specific section

# Then read specific section:
knowns doc readme --plain --section 3
```

### Manual Control (--info, --toc, --section)

If you need manual control instead of `--smart`:

```bash
knowns doc <path> --info --plain     # Check size/tokens
knowns doc <path> --toc --plain      # View table of contents
knowns doc <path> --section "3" --plain  # Read specific section
```

---

## time

```bash
knowns time start <id>    # REQUIRED when taking task
knowns time stop          # REQUIRED when completing
knowns time pause
knowns time resume
knowns time status
knowns time add <id> <duration> -n "Note" -d "2025-01-01"
```

---

## search

```bash
knowns search "query" --plain
knowns search "auth" --type task --plain
knowns search "api" --type doc --plain
knowns search "bug" --type task --status in-progress --priority high --plain
```

---

## Multi-line Input (Bash/Zsh)

```bash
knowns task edit <id> --plan $'1. Step\n2. Step\n3. Step'
```

---

# Task Creation

## Before Creating

```bash
# Search for existing tasks first
knowns search "keyword" --type task --plain
```

---

## Create Task

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
| ❌ Bad | ✅ Good |
|--------|---------|
| Do auth stuff | Add JWT authentication |
| Fix bug | Fix login timeout |

### Description
Explain WHY. Include doc refs: `@doc/security-patterns`

### Acceptance Criteria
**Outcome-focused, NOT implementation steps:**

| ❌ Bad | ✅ Good |
|--------|---------|
| Add handleLogin() function | User can login |
| Use bcrypt | Passwords are hashed |
| Add try-catch | Errors return proper HTTP codes |

---

## Subtasks

```bash
knowns task create "Parent task"
knowns task create "Subtask" --parent 48  # Raw ID only!
```

---

## Anti-Patterns

- ❌ Too many AC in one task → Split into multiple tasks
- ❌ Implementation steps as AC → Write outcomes instead
- ❌ Skip search → Always check existing tasks first

---

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
# @doc/xxx → knowns doc "xxx" --plain
# @task-YY → knowns task YY --plain

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

---

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

---

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
| Ignore task refs | Follow ALL `@task-xxx` and `@doc/xxx` refs |

---

## Error Recovery

| Problem | Solution |
|---------|----------|
| Set assignee to AC text | `knowns task edit <id> -a @me` |
| Forgot to stop timer | `knowns time add <id> <duration>` |
| Checked AC too early | `knowns task edit <id> --uncheck-ac N` |
| Task not found | `knowns task list --plain` |
<!-- KNOWNS GUIDELINES END -->