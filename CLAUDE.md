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

| Context | Task Format | Doc Format |
|---------|-------------|------------|
| **Writing** (input) | `@task-<id>` | `@doc/<path>` |
| **Reading** (output) | `@.knowns/tasks/task-<id>` | `@.knowns/docs/<path>.md` |

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

# CLI Commands Reference

Complete reference for all Knowns CLI commands.

---

## Task Commands

### task create

```
knowns task create <title> [options]
```

| Flag | Short | Purpose | Example |
|------|-------|---------|---------|
| `--description` | `-d` | Task description | `-d "Fix the login bug"` |
| `--ac` | | Acceptance criterion (repeatable) | `--ac "User can login"` |
| `--labels` | `-l` | Comma-separated labels | `-l "bug,urgent"` |
| `--assignee` | `-a` | Assign to user | `-a @username` |
| `--priority` | | low/medium/high | `--priority high` |
| `--status` | `-s` | Initial status | `-s todo` |
| `--parent` | | Parent task ID (raw ID only!) | `--parent 48` |

**Example:**
```bash
knowns task create "Fix login timeout" \
  -d "Users experience timeout on slow networks" \
  --ac "Login works on 3G connection" \
  --ac "Timeout increased to 30s" \
  -l "bug,auth" \
  --priority high
```

---

### task edit

```
knowns task edit <id> [options]
```

| Flag | Short | Purpose | Example |
|------|-------|---------|---------|
| `--title` | `-t` | Change title | `-t "New title"` |
| `--description` | `-d` | Change description | `-d "New desc"` |
| `--status` | `-s` | Change status | `-s in-progress` |
| `--priority` | | Change priority | `--priority high` |
| `--labels` | `-l` | Set labels | `-l "bug,urgent"` |
| `--assignee` | `-a` | Assign user ⚠️ | `-a @username` |
| `--parent` | | Move to parent | `--parent 48` |
| `--ac` | | Add acceptance criterion | `--ac "New criterion"` |
| `--check-ac` | | Mark AC done (1-indexed) | `--check-ac 1` |
| `--uncheck-ac` | | Unmark AC (1-indexed) | `--uncheck-ac 1` |
| `--remove-ac` | | Delete AC (1-indexed) | `--remove-ac 3` |
| `--plan` | | Set implementation plan | `--plan "1. Step one"` |
| `--notes` | | Replace notes | `--notes "Summary"` |
| `--append-notes` | | Add to notes | `--append-notes "✓ Done"` |

**⚠️ WARNING:** `-a` is assignee, NOT acceptance criteria! Use `--ac` for AC.

**Examples:**
```bash
# Take task
knowns task edit abc123 -s in-progress -a @me

# Add acceptance criteria (use --ac, NOT -a!)
knowns task edit abc123 --ac "Feature works offline"

# Check criteria as done (1-indexed)
knowns task edit abc123 --check-ac 1 --check-ac 2

# Add implementation plan
knowns task edit abc123 --plan $'1. Research\n2. Implement\n3. Test'

# Add progress notes
knowns task edit abc123 --append-notes "✓ Completed research phase"

# Complete task
knowns task edit abc123 -s done
```

---

### task view/list

```bash
# View single task (ALWAYS use --plain for AI)
knowns task <id> --plain
knowns task view <id> --plain

# List tasks
knowns task list --plain
knowns task list --status in-progress --plain
knowns task list --assignee @me --plain
knowns task list --tree --plain
```

---

## Doc Commands

### doc create

```
knowns doc create <title> [options]
```

| Flag | Short | Purpose | Example |
|------|-------|---------|---------|
| `--description` | `-d` | Description | `-d "API reference"` |
| `--tags` | `-t` | Comma-separated tags | `-t "api,reference"` |
| `--folder` | `-f` | Folder path | `-f "guides"` |

**Example:**
```bash
knowns doc create "API Reference" \
  -d "REST API documentation" \
  -t "api,docs" \
  -f "api"
```

---

### doc edit

```
knowns doc edit <name> [options]
```

| Flag | Short | Purpose | Example |
|------|-------|---------|---------|
| `--title` | `-t` | Change title | `-t "New Title"` |
| `--description` | `-d` | Change description | `-d "New desc"` |
| `--tags` | | Set tags | `--tags "new,tags"` |
| `--content` | `-c` | Replace content | `-c "New content"` |
| `--append` | `-a` | Append content ⚠️ | `-a "Added section"` |
| `--content-file` | | Content from file | `--content-file ./content.md` |
| `--append-file` | | Append from file | `--append-file ./more.md` |

**⚠️ NOTE:** In doc edit, `-a` means append content, NOT assignee!

**Examples:**
```bash
# Replace content
knowns doc edit "readme" -c "# New Content"

# Append content
knowns doc edit "readme" -a "## New Section"
```

---

### doc view/list

```bash
# View doc (ALWAYS use --plain for AI)
knowns doc <path> --plain
knowns doc view "<path>" --plain

# List docs
knowns doc list --plain
knowns doc list --tag api --plain
knowns doc list "guides/" --plain
```

---

## Time Commands

```bash
# Start timer (REQUIRED when taking task)
knowns time start <taskId>

# Stop timer (REQUIRED when completing task)
knowns time stop

# Pause/resume
knowns time pause
knowns time resume

# Check status
knowns time status

# Manual entry
knowns time add <taskId> <duration> -n "Note" -d "2025-01-01"
# duration: "2h", "30m", "1h30m"

# Report
knowns time report --from "2025-01-01" --to "2025-12-31"
```

---

## Search Commands

```bash
# Search everything
knowns search "query" --plain

# Search by type
knowns search "auth" --type task --plain
knowns search "api" --type doc --plain

# Filter by status/priority
knowns search "bug" --type task --status in-progress --priority high --plain
```

---

## Multi-line Input

Different shells handle multi-line strings differently:

**Bash/Zsh (ANSI-C quoting):**
```bash
knowns task edit <id> --plan $'1. Step one\n2. Step two\n3. Step three'
```

**PowerShell:**
```powershell
knowns task edit <id> --plan "1. Step one`n2. Step two`n3. Step three"
```

**Cross-platform (heredoc):**
```bash
knowns task edit <id> --plan "$(cat <<EOF
1. Step one
2. Step two
3. Step three
EOF
)"
```

---

## MCP Tools (Alternative to CLI)

| Action | MCP Tool |
|--------|----------|
| List tasks | `list_tasks({})` |
| Get task | `get_task({ taskId })` |
| Create task | `create_task({ title, description, priority, labels })` |
| Update task | `update_task({ taskId, status, assignee, plan, notes })` |
| Search tasks | `search_tasks({ query })` |
| List docs | `list_docs({})` |
| Get doc | `get_doc({ path })` |
| Create doc | `create_doc({ title, description, tags, folder })` |
| Update doc | `update_doc({ path, content, appendContent })` |
| Start timer | `start_time({ taskId })` |
| Stop timer | `stop_time({ taskId })` |

**Note:** MCP does NOT support acceptance criteria operations. Use CLI:
```bash
knowns task edit <id> --ac "criterion"
knowns task edit <id> --check-ac 1
```

---

# Task Creation Workflow

Guide for creating well-structured tasks.

---

## Step 1: Search First

Before creating a new task, check if similar work already exists:

```bash
# Search for existing tasks
knowns search "keyword" --type task --plain

# List tasks by status
knowns task list --status todo --plain
knowns task list --status in-progress --plain
```

**Why?** Avoid duplicate work and understand existing context.

---

## Step 2: Assess Scope

Ask yourself:
- Does this work fit in one PR?
- Does it span multiple systems?
- Are there natural breaking points?

**Single task:** Work is focused, affects one area
**Multiple tasks:** Work spans different subsystems or has phases

---

## Step 3: Create with Proper Structure

### Basic Task Creation

```bash
knowns task create "Clear title describing what needs to be done" \
  -d "Description explaining WHY this is needed" \
  --ac "First acceptance criterion" \
  --ac "Second acceptance criterion" \
  --priority medium \
  -l "label1,label2"
```

### Creating Subtasks

```bash
# Create parent task first
knowns task create "Parent feature"

# Create subtasks (use raw ID, not task-XX)
knowns task create "Subtask 1" --parent 48
knowns task create "Subtask 2" --parent 48
```

---

## Task Quality Guidelines

### Title (The "what")

Clear, brief summary of the task.

| ❌ Bad | ✅ Good |
|--------|---------|
| Do auth stuff | Add JWT authentication |
| Fix bug | Fix login timeout on slow networks |
| Update docs | Document rate limiting in API.md |

### Description (The "why")

Explains context and purpose. Include doc references.

```markdown
We need JWT authentication because sessions don't scale
for our microservices architecture.

Related: @doc/security-patterns, @doc/api-guidelines
```

### Acceptance Criteria (The "what" - outcomes)

**Key Principles:**
- **Outcome-oriented** - Focus on results, not implementation
- **Testable** - Can be objectively verified
- **User-focused** - Frame from end-user perspective

| ❌ Bad (Implementation details) | ✅ Good (Outcomes) |
|--------------------------------|-------------------|
| Add function handleLogin() in auth.ts | User can login and receive JWT token |
| Use bcrypt for hashing | Passwords are securely hashed |
| Add try-catch blocks | Errors return appropriate HTTP status codes |

---

## Anti-Patterns to Avoid

### ❌ Don't create overly broad tasks

```bash
# ❌ Too broad - too many ACs
knowns task create "Build entire auth system" \
  --ac "Login" --ac "Logout" --ac "Register" \
  --ac "Password reset" --ac "OAuth" --ac "2FA"

# ✅ Better - split into focused tasks
knowns task create "Implement user login" --ac "User can login with email/password"
knowns task create "Implement user registration" --ac "User can create account"
```

### ❌ Don't embed implementation steps in AC

```bash
# ❌ Implementation steps as AC
--ac "Create auth.ts file"
--ac "Add bcrypt dependency"
--ac "Write handleLogin function"

# ✅ Outcome-focused AC
--ac "User can login with valid credentials"
--ac "Invalid credentials return 401 error"
--ac "Successful login returns JWT token"
```

### ❌ Don't skip search

Always search for existing tasks first. You might find:
- Duplicate task already exists
- Related task with useful context
- Completed task with reusable patterns

---

## Report Results

After creating tasks, show the user:
- Task ID
- Title
- Description summary
- Acceptance criteria

This allows for feedback and corrections before work begins.

---

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

---

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

---

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
<!-- KNOWNS GUIDELINES END -->