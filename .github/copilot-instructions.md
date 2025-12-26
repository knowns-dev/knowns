<!-- KNOWNS GUIDELINES START -->
# Knowns CLI Guidelines

## Core Principles

### 1. CLI-Only Operations
**NEVER edit .md files directly. ALL operations MUST use CLI commands.**

This ensures data integrity, maintains proper change history, and prevents file corruption.

### 2. Documentation-First (For AI Agents)
**ALWAYS read project documentation BEFORE planning or coding.**

AI agents must understand project context, conventions, and existing patterns before making any changes. This prevents rework and ensures consistency.

---

## AI Agent Guidelines

> **CRITICAL**: Before performing ANY task, AI agents MUST read documentation to understand project context.

### First-Time Initialization

When starting a new session or working on an unfamiliar project:

```bash
# 1. List all available documentation
knowns doc list --plain

# 2. Read essential project docs (prioritize these)
knowns doc view "README" --plain           # Project overview
knowns doc view "ARCHITECTURE" --plain     # System design
knowns doc view "CONVENTIONS" --plain      # Coding standards
knowns doc view "API" --plain              # API specifications

# 3. Review current task backlog
knowns task list --plain
knowns task list --status in-progress --plain
```

### Before Taking Any Task

```bash
# 1. View the task details
knowns task view <id> --plain

# 2. Follow ALL refs in the task (see Reference System section)
# @.knowns/tasks/task-44 - ... → knowns task view 44 --plain
# @.knowns/docs/patterns/module.md → knowns doc view "patterns/module" --plain

# 3. Search for additional related documentation
knowns search "<keywords from task>" --type doc --plain

# 4. Read ALL related docs before planning
knowns doc view "<related-doc>" --plain

# 5. Check for similar completed tasks (learn from history)
knowns search "<keywords>" --type task --status done --plain
```

### Why Documentation First?

| Without Reading Docs | With Reading Docs |
|---------------------|-------------------|
| Reinvent existing patterns | Reuse established patterns |
| Break conventions | Follow project standards |
| Duplicate code | Use existing utilities |
| Wrong architecture decisions | Align with system design |
| Inconsistent naming | Match naming conventions |

### Context Checklist for Agents

Before writing ANY code, ensure you can answer:

- [ ] Have I followed ALL refs (`@.knowns/...`) in the task?
- [ ] Have I followed nested refs recursively?
- [ ] What is the project's overall architecture?
- [ ] What coding conventions does this project follow?
- [ ] Are there existing patterns/utilities I should reuse?
- [ ] What are the testing requirements?
- [ ] How should I structure my implementation?

> **Remember**: A few minutes reading docs saves hours of rework. NEVER skip this step.

---

## Reference System (Refs)

Tasks and docs can contain **references** to other tasks/docs. AI agents MUST understand and follow these refs to gather complete context.

### Reference Formats

| Type | User Input | System Output | CLI Command |
|------|------------|---------------|-------------|
| **Task ref** | `@task-<id>` | `@.knowns/tasks/task-<id> - <title>.md` | `knowns task view <id> --plain` |
| **Doc ref** | `@doc/<path>` | `@.knowns/docs/<path>.md` | `knowns doc view "<path>" --plain` |

### How to Follow Refs

When you read a task and see refs in system output format, follow them:

```bash
# Example: Task 42 output contains:
# @.knowns/tasks/task-44 - CLI Task Create Command.md
# @.knowns/docs/patterns/module.md

# Follow task ref (extract ID from task-<id>)
knowns task view 44 --plain

# Follow doc ref (extract path, remove .md)
knowns doc view "patterns/module" --plain
```

### Parsing Rules

1. **Task refs**: `@.knowns/tasks/task-<id> - ...` → extract `<id>` → `knowns task view <id> --plain`
2. **Doc refs**: `@.knowns/docs/<path>.md` → extract `<path>` → `knowns doc view "<path>" --plain`

### Recursive Following

Refs can be nested. Follow until complete context is gathered:

```
Task 42
  → @.knowns/docs/README.md
    → @.knowns/docs/patterns/module.md (found in README)
      → (read for full pattern details)
```

### When to Follow Refs

| Situation | Action |
|-----------|--------|
| Refs in Description | ALWAYS follow - critical context |
| Refs in Implementation Plan | Follow if implementing related work |
| Refs in Notes | Optional - for historical context |
| Dependency mentions | Follow if marked as blocker |

### Example: Complete Ref Resolution

```bash
# 1. Read the task
$ knowns task view 42 --plain

# Output contains:
# @.knowns/tasks/task-44 - CLI Task Create Command.md
# @.knowns/docs/README.md

# 2. Follow task ref
$ knowns task view 44 --plain

# 3. Follow doc ref
$ knowns doc view "README" --plain

# 4. If README contains more refs, follow them too
# @.knowns/docs/patterns/module.md → knowns doc view "patterns/module" --plain

# Now you have complete context
```

> **CRITICAL**: Never assume you understand a task fully without following its refs. Refs contain essential context that may change your implementation approach.

---

## Quick Start

```bash
# Initialize project
knowns init [name]

# Create task with acceptance criteria
knowns task create "Title" -d "Description" --ac "Criterion 1" --ac "Criterion 2"

# View task (ALWAYS use --plain for AI)
knowns task view <id> --plain

# List tasks
knowns task list --plain

# Search (tasks + docs)
knowns search "query" --plain
```

---

## End-to-End Example

Here's a complete workflow for an AI agent implementing a feature:

```bash
# === AGENT SESSION START (Do this once per session) ===

# 0a. List all available documentation
$ knowns doc list --plain

# Output:
# DOC: README.md
# DOC: ARCHITECTURE.md
# DOC: CONVENTIONS.md
# DOC: security-patterns.md
# DOC: api-guidelines.md
# DOC: email-templates.md

# 0b. Read essential project docs
$ knowns doc view "README" --plain
$ knowns doc view "ARCHITECTURE" --plain
$ knowns doc view "CONVENTIONS" --plain

# Now the agent understands project context and conventions

# === TASK WORKFLOW ===

# 1. Create the task
$ knowns task create "Add password reset flow" \
    -d "Users need ability to reset forgotten passwords via email" \
    --ac "User can request password reset via email" \
    --ac "Reset link expires after 1 hour" \
    --ac "User can set new password via reset link" \
    --ac "Unit tests cover all scenarios" \
    --priority high \
    -l "auth,feature"

# Output: Created task AUTH-042

# 2. Take the task and start timer
$ knowns task edit AUTH-042 -s in-progress -a @me
$ knowns time start AUTH-042

# Output: Timer started for AUTH-042

# 3. Search for related documentation
$ knowns search "password security" --type doc --plain

# Output:
# DOC: security-patterns.md (score: 0.92)
# DOC: email-templates.md (score: 0.78)

# 4. Read the documentation
$ knowns doc view "security-patterns" --plain

# 5. Create implementation plan (SHARE WITH USER, WAIT FOR APPROVAL)
$ knowns task edit AUTH-042 --plan $'1. Review security patterns (see [security-patterns.md](./docs/security-patterns.md))
2. Design token generation with 1-hour expiry
3. Create email template (see [email-templates.md](./docs/email-templates.md))
4. Implement /forgot-password endpoint
5. Implement /reset-password endpoint
6. Add unit tests
7. Update API documentation'

# 6. After approval, implement and check criteria as you go
$ knowns task edit AUTH-042 --check-ac 1
$ knowns task edit AUTH-042 --append-notes "✓ Implemented /forgot-password endpoint"

$ knowns task edit AUTH-042 --check-ac 2
$ knowns task edit AUTH-042 --append-notes "✓ Token expiry set to 1 hour"

$ knowns task edit AUTH-042 --check-ac 3
$ knowns task edit AUTH-042 --append-notes "✓ Implemented /reset-password endpoint"

$ knowns task edit AUTH-042 --check-ac 4
$ knowns task edit AUTH-042 --append-notes "✓ Added 12 unit tests, 100% coverage"

# 7. Add final implementation notes
$ knowns task edit AUTH-042 --notes $'## Summary
Implemented complete password reset flow with secure token generation.

## Changes
- Added POST /forgot-password endpoint
- Added POST /reset-password endpoint
- Created password_reset_tokens table
- Added email template for reset link

## Security
- Tokens use crypto.randomBytes(32)
- 1-hour expiry enforced at DB level
- Rate limiting: 3 requests per hour per email

## Tests
- 12 unit tests added
- Coverage: 100% for new code

## Documentation
- Updated API.md with new endpoints'

# 8. Stop timer and complete
$ knowns time stop
$ knowns task edit AUTH-042 -s done

# Output: Task AUTH-042 marked as done
```

---

## Task Workflow

### Step 1: Take Task

```bash
knowns task edit <id> -s in-progress -a @me
```

> **Note**: `@me` is a special keyword that assigns the task to yourself. You can also use specific usernames like `@harry` or `@john`.

### Step 2: Start Time Tracking

```bash
knowns time start <id>
```

### Step 3: Read Related Documentation

> **FOR AI AGENTS**: This step is MANDATORY, not optional. You must understand the codebase before planning.

```bash
# Search for related docs
knowns search "authentication" --type doc --plain

# View relevant documents
knowns doc view "API Guidelines" --plain
knowns doc view "Security Patterns" --plain

# Also check for similar completed tasks
knowns search "auth" --type task --status done --plain
```

> **CRITICAL**: ALWAYS read related documentation BEFORE planning! Understanding existing patterns and conventions prevents rework and ensures consistency.

### Step 4: Create Implementation Plan

```bash
knowns task edit <id> --plan $'1. Research patterns (see [security-patterns.md](./security-patterns.md))
2. Design middleware
3. Implement
4. Add tests
5. Update docs'
```

> **CRITICAL**:
> - Share plan with user and **WAIT for approval** before coding
> - Include doc references using `[file.md](./path/file.md)` format

### Step 5: Implement

```bash
# Check acceptance criteria as you complete them
knowns task edit <id> --check-ac 1 --check-ac 2 --check-ac 3
```

### Step 6: Add Implementation Notes

```bash
# Add comprehensive notes (suitable for PR description)
knowns task edit <id> --notes $'## Summary

Implemented JWT auth.

## Changes
- Added middleware
- Added tests'

# OR append progressively (recommended)
knowns task edit <id> --append-notes "✓ Implemented middleware"
knowns task edit <id> --append-notes "✓ Added tests"
```

### Step 7: Stop Time Tracking

```bash
knowns time stop
```

### Step 8: Complete Task

```bash
knowns task edit <id> -s done
```

---

## Essential Commands

### Task Management

```bash
# Create task
knowns task create "Title" -d "Description" --ac "Criterion" -l "labels" --priority high

# Edit task
knowns task edit <id> -t "New title"
knowns task edit <id> -d "New description"
knowns task edit <id> -s in-progress
knowns task edit <id> --priority high
knowns task edit <id> -a @me

# Acceptance Criteria
knowns task edit <id> --ac "New criterion"           # Add
knowns task edit <id> --check-ac 1 --check-ac 2      # Check (1-indexed)
knowns task edit <id> --uncheck-ac 2                 # Uncheck
knowns task edit <id> --remove-ac 3                  # Remove

# Implementation Plan & Notes
knowns task edit <id> --plan $'1. Step\n2. Step'
knowns task edit <id> --notes "Implementation summary"
knowns task edit <id> --append-notes "Progress update"

# View & List
knowns task view <id> --plain                        # ALWAYS use --plain
knowns task list --plain
knowns task list --status in-progress --plain
knowns task list --assignee @me --plain
knowns task list --tree --plain                      # Tree hierarchy
```

### Time Tracking

```bash
# Timer
knowns time start <id>
knowns time stop
knowns time pause
knowns time resume
knowns time status

# Manual entry
knowns time add <id> 2h -n "Note" -d "2025-12-25"

# Reports
knowns time report --from "2025-12-01" --to "2025-12-31"
knowns time report --by-label --csv > report.csv
```

### Documentation

```bash
# List & View
knowns doc list --plain
knowns doc list --tag architecture --plain
knowns doc view "Doc Name" --plain

# Create (with optional folder)
knowns doc create "Title" -d "Description" -t "tags"
knowns doc create "Title" -d "Description" -t "tags" -f "folder/path"

# Edit metadata
knowns doc edit "Doc Name" -t "New Title" --tags "new,tags"

# Edit content
knowns doc edit "Doc Name" -c "New content"        # Replace content
knowns doc edit "Doc Name" -a "Appended content"   # Append to content
```

### Search

```bash
# Search everything
knowns search "query" --plain

# Search specific type
knowns search "auth" --type task --plain
knowns search "patterns" --type doc --plain

# Filter
knowns search "bug" --status in-progress --priority high --plain
```

---

## Task Structure

### Title

Clear summary (WHAT needs to be done).

| Bad | Good |
|-----|------|
| Do auth stuff | Add JWT authentication |
| Fix bug | Fix login timeout on slow networks |
| Update docs | Document rate limiting in API.md |

### Description

Explains WHY and WHAT (not HOW). **Link related docs using `[file.md](./path/file.md)`**

```markdown
We need JWT authentication because sessions don't scale for our microservices architecture.

Related docs:
- [security-patterns.md](./docs/security-patterns.md)
- [api-guidelines.md](./docs/api-guidelines.md)
```

### Acceptance Criteria

**Outcome-oriented**, testable criteria. NOT implementation steps.

| Bad (Implementation details) | Good (Outcomes) |
|------------------------------|-----------------|
| Add function handleLogin() in auth.ts | User can login and receive JWT token |
| Use bcrypt for hashing | Passwords are securely hashed |
| Add try-catch blocks | Errors return appropriate HTTP status codes |

### Implementation Plan

HOW to solve. Added AFTER taking task, BEFORE coding.

```markdown
1. Research JWT libraries (see [security-patterns.md](./docs/security-patterns.md))
2. Design token structure (access + refresh tokens)
3. Implement auth middleware
4. Add unit tests (aim for 90%+ coverage)
5. Update API.md with new endpoints
```

### Implementation Notes

Summary for PR description. Added AFTER completion.

```markdown
## Summary
Implemented JWT auth using jsonwebtoken library.

## Changes
- Added auth middleware in src/middleware/auth.ts
- Added /login and /refresh endpoints
- Created JWT utility functions

## Tests
- Added 15 unit tests
- Coverage: 94%

## Documentation
- Updated API.md with authentication section
```

---

## Error Handling

### Common Errors and Solutions

| Error | Cause | Solution |
|-------|-------|----------|
| `Error: Task not found` | Invalid task ID | Run `knowns task list --plain` to find correct ID |
| `Error: No active timer` | Calling `time stop` without active timer | Start timer first: `knowns time start <id>` |
| `Error: Timer already running` | Starting timer when one is active | Stop current: `knowns time stop` |
| `Error: Invalid status` | Wrong status format | Use lowercase with hyphens: `in-progress`, not `In Progress` |
| `Error: AC index out of range` | Checking non-existent criterion | View task first: `knowns task view <id> --plain` |
| `Error: Document not found` | Wrong document name | Run `knowns doc list --plain` to find correct name |
| `Error: Not initialized` | Running commands without init | Run `knowns init` first |

### Debugging Commands

```bash
# Check CLI version
knowns --version

# Verify project is initialized
knowns status

# View raw task data (for debugging)
knowns task view <id> --json

# Check timer status
knowns time status
```

---

## Definition of Done

A task is **Done** ONLY when **ALL** criteria are met:

### Via CLI (Required)

- [ ] All acceptance criteria checked: `--check-ac <index>`
- [ ] Implementation notes added: `--notes "..."`
- [ ] Timer stopped: `knowns time stop`
- [ ] Status set to done: `-s done`

### Via Code (Required)

- [ ] All tests pass
- [ ] Documentation updated
- [ ] Code reviewed (linting, formatting)
- [ ] No regressions introduced

---

## Status & Priority Reference

### Status Values

Use **lowercase with hyphens**:

| Status | Description | When to Use |
|--------|-------------|-------------|
| `todo` | Not started | Default for new tasks |
| `in-progress` | Currently working | After taking task |
| `in-review` | In code review | PR submitted |
| `blocked` | Waiting on dependency | External blocker |
| `done` | Completed | All criteria met |

### Priority Values

| Priority | Description |
|----------|-------------|
| `low` | Can wait, nice-to-have |
| `medium` | Normal priority (default) |
| `high` | Urgent, time-sensitive |

---

## Common Mistakes

| Wrong | Right |
|-------|-------|
| Edit .md files directly | Use `knowns task edit` |
| Change `- [ ]` to `- [x]` in file | Use `--check-ac <index>` |
| Start coding without reading docs | Read ALL related docs FIRST |
| Skip `knowns doc list` on new project | Always list docs when starting |
| Assume you know the conventions | Read CONVENTIONS/ARCHITECTURE docs |
| Plan without checking docs | Read docs before planning |
| Ignore similar completed tasks | Search done tasks for patterns |
| Missing doc links in description/plan | Link docs using `[file.md](./path)` |
| Forget `--plain` flag | Always use `--plain` for AI |
| Code before plan approval | Share plan, WAIT for approval |
| Mark done without all criteria | Check ALL criteria first |
| Write implementation steps in AC | Write outcome-oriented criteria |
| Use `"In Progress"` or `"Done"` | Use `in-progress`, `done` |
| Use `@yourself` | Use `@me` or specific username |
| Ignore refs in task description | Follow ALL refs (`@.knowns/...`) before planning |
| See `@.knowns/docs/...` but don't read | Use `knowns doc view "<path>" --plain` |
| See `@.knowns/tasks/task-X` but don't check | Use `knowns task view X --plain` for context |
| Follow only first-level refs | Recursively follow nested refs until complete |

---

## Platform-Specific Notes

### Multi-line Input

Different shells handle multi-line strings differently:

**Bash / Zsh (Recommended)**
```bash
knowns task edit <id> --plan $'1. First step\n2. Second step\n3. Third step'
```

**PowerShell**
```powershell
knowns task edit <id> --plan "1. First step`n2. Second step`n3. Third step"
```

**Cross-platform (Using printf)**
```bash
knowns task edit <id> --plan "$(printf '1. First step\n2. Second step\n3. Third step')"
```

**Using heredoc (for long content)**
```bash
knowns task edit <id> --plan "$(cat <<EOF
1. First step
2. Second step
3. Third step
EOF
)"
```

### Path Separators

- **Unix/macOS**: Use forward slashes: `./docs/api.md`
- **Windows**: Both work, but prefer forward slashes for consistency

---

## Best Practices Checklist

### For AI Agents: Session Start

- [ ] List all docs: `knowns doc list --plain`
- [ ] Read README/ARCHITECTURE docs
- [ ] Understand coding conventions
- [ ] Review current task backlog

### Before Starting Work

- [ ] Task has clear acceptance criteria
- [ ] ALL refs in task followed (`@.knowns/...`)
- [ ] Nested refs recursively followed until complete context gathered
- [ ] Related docs searched: `knowns search "keyword" --type doc --plain`
- [ ] ALL relevant docs read: `knowns doc view "Doc Name" --plain`
- [ ] Similar done tasks reviewed for patterns
- [ ] Task assigned to self: `-a @me`
- [ ] Status set to in-progress: `-s in-progress`
- [ ] Timer started: `knowns time start <id>`

### During Work

- [ ] Implementation plan created and approved
- [ ] Doc links included in plan: `[file.md](./path/file.md)`
- [ ] Criteria checked as completed: `--check-ac <index>`
- [ ] Progress notes appended: `--append-notes "✓ ..."`

### After Work

- [ ] All acceptance criteria checked
- [ ] Implementation notes added: `--notes "..."`
- [ ] Timer stopped: `knowns time stop`
- [ ] Tests passing
- [ ] Documentation updated
- [ ] Status set to done: `-s done`

---

## Quick Reference Card

```bash
# === AGENT INITIALIZATION (Once per session) ===
knowns doc list --plain
knowns doc view "README" --plain
knowns doc view "ARCHITECTURE" --plain
knowns doc view "CONVENTIONS" --plain

# === FULL WORKFLOW ===
knowns task create "Title" -d "Description" --ac "Criterion"
knowns task edit <id> -s in-progress -a @me
knowns time start <id>
knowns search "keyword" --type doc --plain
knowns doc view "Doc Name" --plain
knowns search "keyword" --type task --status done --plain  # Learn from history
knowns task edit <id> --plan $'1. Step (see [file.md](./file.md))\n2. Step'
# ... wait for approval, then implement ...
knowns task edit <id> --check-ac 1 --check-ac 2
knowns task edit <id> --append-notes "✓ Completed feature"
knowns time stop
knowns task edit <id> -s done

# === VIEW & SEARCH ===
knowns task view <id> --plain
knowns task list --plain
knowns task list --status in-progress --assignee @me --plain
knowns search "query" --plain
knowns search "bug" --type task --status in-progress --plain

# === TIME TRACKING ===
knowns time start <id>
knowns time stop
knowns time status
knowns time report --from "2025-12-01" --to "2025-12-31"

# === DOCUMENTATION ===
knowns doc list --plain
knowns doc view "path/doc-name" --plain
knowns doc create "Title" -d "Description" -t "tags" -f "folder"
knowns doc edit "doc-name" -c "New content"
knowns doc edit "doc-name" -a "Appended content"
```

---

**Maintained By**: Knowns CLI Team

<!-- KNOWNS GUIDELINES END -->












