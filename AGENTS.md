
<!-- BACKLOG.MD GUIDELINES START -->
# Instructions for the usage of Backlog.md CLI Tool

## Backlog.md: Comprehensive Project Management Tool via CLI

### Assistant Objective

Efficiently manage all project tasks, status, and documentation using the Backlog.md CLI, ensuring all project metadata
remains fully synchronized and up-to-date.

### Core Capabilities

- ✅ **Task Management**: Create, edit, assign, prioritize, and track tasks with full metadata
- ✅ **Search**: Fuzzy search across tasks, documents, and decisions with `backlog search`
- ✅ **Acceptance Criteria**: Granular control with add/remove/check/uncheck by index
- ✅ **Board Visualization**: Terminal-based Kanban board (`backlog board`) and web UI (`backlog browser`)
- ✅ **Git Integration**: Automatic tracking of task states across branches
- ✅ **Dependencies**: Task relationships and subtask hierarchies
- ✅ **Documentation & Decisions**: Structured docs and architectural decision records
- ✅ **Export & Reporting**: Generate markdown reports and board snapshots
- ✅ **AI-Optimized**: `--plain` flag provides clean text output for AI processing

### Why This Matters to You (AI Agent)

1. **Comprehensive system** - Full project management capabilities through CLI
2. **The CLI is the interface** - All operations go through `backlog` commands
3. **Unified interaction model** - You can use CLI for both reading (`backlog task 1 --plain`) and writing (
   `backlog task edit 1`)
4. **Metadata stays synchronized** - The CLI handles all the complex relationships

### Key Understanding

- **Tasks** live in `backlog/tasks/` as `task-<id> - <title>.md` files
- **You interact via CLI only**: `backlog task create`, `backlog task edit`, etc.
- **Use `--plain` flag** for AI-friendly output when viewing/listing
- **Never bypass the CLI** - It handles Git, metadata, file naming, and relationships

---

# ⚠️ CRITICAL: NEVER EDIT TASK FILES DIRECTLY. Edit Only via CLI

**ALL task operations MUST use the Backlog.md CLI commands**

- ✅ **DO**: Use `backlog task edit` and other CLI commands
- ✅ **DO**: Use `backlog task create` to create new tasks
- ✅ **DO**: Use `backlog task edit <id> --check-ac <index>` to mark acceptance criteria
- ❌ **DON'T**: Edit markdown files directly
- ❌ **DON'T**: Manually change checkboxes in files
- ❌ **DON'T**: Add or modify text in task files without using CLI

**Why?** Direct file editing breaks metadata synchronization, Git tracking, and task relationships.

---

## 1. Source of Truth & File Structure

### 📖 **UNDERSTANDING** (What you'll see when reading)

- Markdown task files live under **`backlog/tasks/`** (drafts under **`backlog/drafts/`**)
- Files are named: `task-<id> - <title>.md` (e.g., `task-42 - Add GraphQL resolver.md`)
- Project documentation is in **`backlog/docs/`**
- Project decisions are in **`backlog/decisions/`**

### 🔧 **ACTING** (How to change things)

- **All task operations MUST use the Backlog.md CLI tool**
- This ensures metadata is correctly updated and the project stays in sync
- **Always use `--plain` flag** when listing or viewing tasks for AI-friendly text output

---

## 2. Common Mistakes to Avoid

### ❌ **WRONG: Direct File Editing**

```markdown
# DON'T DO THIS:

1. Open backlog/tasks/task-7 - Feature.md in editor
2. Change "- [ ]" to "- [x]" manually
3. Add notes directly to the file
4. Save the file
```

### ✅ **CORRECT: Using CLI Commands**

```bash
# DO THIS INSTEAD:
backlog task edit 7 --check-ac 1  # Mark AC #1 as complete
backlog task edit 7 --notes "Implementation complete"  # Add notes
backlog task edit 7 -s "In Progress" -a @agent-k  # Multiple commands: change status and assign the task when you start working on the task
```

---

## 3. Understanding Task Format (Read-Only Reference)

⚠️ **FORMAT REFERENCE ONLY** - The following sections show what you'll SEE in task files.
**Never edit these directly! Use CLI commands to make changes.**

### Task Structure You'll See

```markdown
---
id: task-42
title: Add GraphQL resolver
status: To Do
assignee: [@sara]
labels: [backend, api]
---

## Description

Brief explanation of the task purpose.

## Acceptance Criteria

<!-- AC:BEGIN -->

- [ ] #1 First criterion
- [x] #2 Second criterion (completed)
- [ ] #3 Third criterion

<!-- AC:END -->

## Implementation Plan

1. Research approach
2. Implement solution

## Implementation Notes

Summary of what was done.
```

### How to Modify Each Section

| What You Want to Change | CLI Command to Use                                       |
|-------------------------|----------------------------------------------------------|
| Title                   | `backlog task edit 42 -t "New Title"`                    |
| Status                  | `backlog task edit 42 -s "In Progress"`                  |
| Assignee                | `backlog task edit 42 -a @sara`                          |
| Labels                  | `backlog task edit 42 -l backend,api`                    |
| Description             | `backlog task edit 42 -d "New description"`              |
| Add AC                  | `backlog task edit 42 --ac "New criterion"`              |
| Check AC #1             | `backlog task edit 42 --check-ac 1`                      |
| Uncheck AC #2           | `backlog task edit 42 --uncheck-ac 2`                    |
| Remove AC #3            | `backlog task edit 42 --remove-ac 3`                     |
| Add Plan                | `backlog task edit 42 --plan "1. Step one\n2. Step two"` |
| Add Notes (replace)     | `backlog task edit 42 --notes "What I did"`              |
| Append Notes            | `backlog task edit 42 --append-notes "Another note"` |

---

## 4. Defining Tasks

### Creating New Tasks

**Always use CLI to create tasks:**

```bash
# Example
backlog task create "Task title" -d "Description" --ac "First criterion" --ac "Second criterion"
```

### Title (one liner)

Use a clear brief title that summarizes the task.

### Description (The "why")

Provide a concise summary of the task purpose and its goal. Explains the context without implementation details.

### Acceptance Criteria (The "what")

**Understanding the Format:**

- Acceptance criteria appear as numbered checkboxes in the markdown files
- Format: `- [ ] #1 Criterion text` (unchecked) or `- [x] #1 Criterion text` (checked)

**Managing Acceptance Criteria via CLI:**

⚠️ **IMPORTANT: How AC Commands Work**

- **Adding criteria (`--ac`)** accepts multiple flags: `--ac "First" --ac "Second"` ✅
- **Checking/unchecking/removing** accept multiple flags too: `--check-ac 1 --check-ac 2` ✅
- **Mixed operations** work in a single command: `--check-ac 1 --uncheck-ac 2 --remove-ac 3` ✅

```bash
# Examples

# Add new criteria (MULTIPLE values allowed)
backlog task edit 42 --ac "User can login" --ac "Session persists"

# Check specific criteria by index (MULTIPLE values supported)
backlog task edit 42 --check-ac 1 --check-ac 2 --check-ac 3  # Check multiple ACs
# Or check them individually if you prefer:
backlog task edit 42 --check-ac 1    # Mark #1 as complete
backlog task edit 42 --check-ac 2    # Mark #2 as complete

# Mixed operations in single command
backlog task edit 42 --check-ac 1 --uncheck-ac 2 --remove-ac 3

# ❌ STILL WRONG - These formats don't work:
# backlog task edit 42 --check-ac 1,2,3  # No comma-separated values
# backlog task edit 42 --check-ac 1-3    # No ranges
# backlog task edit 42 --check 1         # Wrong flag name

# Multiple operations of same type
backlog task edit 42 --uncheck-ac 1 --uncheck-ac 2  # Uncheck multiple ACs
backlog task edit 42 --remove-ac 2 --remove-ac 4    # Remove multiple ACs (processed high-to-low)
```

**Key Principles for Good ACs:**

- **Outcome-Oriented:** Focus on the result, not the method.
- **Testable/Verifiable:** Each criterion should be objectively testable
- **Clear and Concise:** Unambiguous language
- **Complete:** Collectively cover the task scope
- **User-Focused:** Frame from end-user or system behavior perspective

Good Examples:

- "User can successfully log in with valid credentials"
- "System processes 1000 requests per second without errors"
- "CLI preserves literal newlines in description/plan/notes; `\\n` sequences are not auto‑converted"

Bad Example (Implementation Step):

- "Add a new function handleLogin() in auth.ts"
- "Define expected behavior and document supported input patterns"

### Task Breakdown Strategy

1. Identify foundational components first
2. Create tasks in dependency order (foundations before features)
3. Ensure each task delivers value independently
4. Avoid creating tasks that block each other

### Task Requirements

- Tasks must be **atomic** and **testable** or **verifiable**
- Each task should represent a single unit of work for one PR
- **Never** reference future tasks (only tasks with id < current task id)
- Ensure tasks are **independent** and don't depend on future work

---

## 5. Implementing Tasks

### 5.1. First step when implementing a task

The very first things you must do when you take over a task are:

* set the task in progress
* assign it to yourself

```bash
# Example
backlog task edit 42 -s "In Progress" -a @{myself}
```

### 5.2. Create an Implementation Plan (The "how")

Previously created tasks contain the why and the what. Once you are familiar with that part you should think about a
plan on **HOW** to tackle the task and all its acceptance criteria. This is your **Implementation Plan**.
First do a quick check to see if all the tools that you are planning to use are available in the environment you are
working in.   
When you are ready, write it down in the task so that you can refer to it later.

```bash
# Example
backlog task edit 42 --plan "1. Research codebase for references\n2Research on internet for similar cases\n3. Implement\n4. Test"
```

## 5.3. Implementation

Once you have a plan, you can start implementing the task. This is where you write code, run tests, and make sure
everything works as expected. Follow the acceptance criteria one by one and MARK THEM AS COMPLETE as soon as you
finish them.

### 5.4 Implementation Notes (PR description)

When you are done implementing a tasks you need to prepare a PR description for it.
Because you cannot create PRs directly, write the PR as a clean description in the task notes.
Append notes progressively during implementation using `--append-notes`:

```
backlog task edit 42 --append-notes "Implemented X" --append-notes "Added tests"
```

```bash
# Example
backlog task edit 42 --notes "Implemented using pattern X because Reason Y, modified files Z and W"
```

**IMPORTANT**: Do NOT include an Implementation Plan when creating a task. The plan is added only after you start the
implementation.

- Creation phase: provide Title, Description, Acceptance Criteria, and optionally labels/priority/assignee.
- When you begin work, switch to edit, set the task in progress and assign to yourself
  `backlog task edit <id> -s "In Progress" -a "..."`.
- Think about how you would solve the task and add the plan: `backlog task edit <id> --plan "..."`.
- After updating the plan, share it with the user and ask for confirmation. Do not begin coding until the user approves the plan or explicitly tells you to skip the review.
- Add Implementation Notes only after completing the work: `backlog task edit <id> --notes "..."` (replace) or append progressively using `--append-notes`.

## Phase discipline: What goes where

- Creation: Title, Description, Acceptance Criteria, labels/priority/assignee.
- Implementation: Implementation Plan (after moving to In Progress and assigning to yourself).
- Wrap-up: Implementation Notes (Like a PR description), AC and Definition of Done checks.

**IMPORTANT**: Only implement what's in the Acceptance Criteria. If you need to do more, either:

1. Update the AC first: `backlog task edit 42 --ac "New requirement"`
2. Or create a new follow up task: `backlog task create "Additional feature"`

---

## 6. Typical Workflow

```bash
# 1. Identify work
backlog task list -s "To Do" --plain

# 2. Read task details
backlog task 42 --plain

# 3. Start work: assign yourself & change status
backlog task edit 42 -s "In Progress" -a @myself

# 4. Add implementation plan
backlog task edit 42 --plan "1. Analyze\n2. Refactor\n3. Test"

# 5. Share the plan with the user and wait for approval (do not write code yet)

# 6. Work on the task (write code, test, etc.)

# 7. Mark acceptance criteria as complete (supports multiple in one command)
backlog task edit 42 --check-ac 1 --check-ac 2 --check-ac 3  # Check all at once
# Or check them individually if preferred:
# backlog task edit 42 --check-ac 1
# backlog task edit 42 --check-ac 2
# backlog task edit 42 --check-ac 3

# 8. Add implementation notes (PR Description)
backlog task edit 42 --notes "Refactored using strategy pattern, updated tests"

# 9. Mark task as done
backlog task edit 42 -s Done
```

---

## 7. Definition of Done (DoD)

A task is **Done** only when **ALL** of the following are complete:

### ✅ Via CLI Commands:

1. **All acceptance criteria checked**: Use `backlog task edit <id> --check-ac <index>` for each
2. **Implementation notes added**: Use `backlog task edit <id> --notes "..."`
3. **Status set to Done**: Use `backlog task edit <id> -s Done`

### ✅ Via Code/Testing:

4. **Tests pass**: Run test suite and linting
5. **Documentation updated**: Update relevant docs if needed
6. **Code reviewed**: Self-review your changes
7. **No regressions**: Performance, security checks pass

⚠️ **NEVER mark a task as Done without completing ALL items above**

---

## 8. Finding Tasks and Content with Search

When users ask you to find tasks related to a topic, use the `backlog search` command with `--plain` flag:

```bash
# Search for tasks about authentication
backlog search "auth" --plain

# Search only in tasks (not docs/decisions)
backlog search "login" --type task --plain

# Search with filters
backlog search "api" --status "In Progress" --plain
backlog search "bug" --priority high --plain
```

**Key points:**
- Uses fuzzy matching - finds "authentication" when searching "auth"
- Searches task titles, descriptions, and content
- Also searches documents and decisions unless filtered with `--type task`
- Always use `--plain` flag for AI-readable output

---

## 9. Quick Reference: DO vs DON'T

### Viewing and Finding Tasks

| Task         | ✅ DO                        | ❌ DON'T                         |
|--------------|-----------------------------|---------------------------------|
| View task    | `backlog task 42 --plain`   | Open and read .md file directly |
| List tasks   | `backlog task list --plain` | Browse backlog/tasks folder     |
| Check status | `backlog task 42 --plain`   | Look at file content            |
| Find by topic| `backlog search "auth" --plain` | Manually grep through files |

### Modifying Tasks

| Task          | ✅ DO                                 | ❌ DON'T                           |
|---------------|--------------------------------------|-----------------------------------|
| Check AC      | `backlog task edit 42 --check-ac 1`  | Change `- [ ]` to `- [x]` in file |
| Add notes     | `backlog task edit 42 --notes "..."` | Type notes into .md file          |
| Change status | `backlog task edit 42 -s Done`       | Edit status in frontmatter        |
| Add AC        | `backlog task edit 42 --ac "New"`    | Add `- [ ] New` to file           |

---

## 10. Complete CLI Command Reference

### Task Creation

| Action           | Command                                                                             |
|------------------|-------------------------------------------------------------------------------------|
| Create task      | `backlog task create "Title"`                                                       |
| With description | `backlog task create "Title" -d "Description"`                                      |
| With AC          | `backlog task create "Title" --ac "Criterion 1" --ac "Criterion 2"`                 |
| With all options | `backlog task create "Title" -d "Desc" -a @sara -s "To Do" -l auth --priority high` |
| Create draft     | `backlog task create "Title" --draft`                                               |
| Create subtask   | `backlog task create "Title" -p 42`                                                 |

### Task Modification

| Action           | Command                                     |
|------------------|---------------------------------------------|
| Edit title       | `backlog task edit 42 -t "New Title"`       |
| Edit description | `backlog task edit 42 -d "New description"` |
| Change status    | `backlog task edit 42 -s "In Progress"`     |
| Assign           | `backlog task edit 42 -a @sara`             |
| Add labels       | `backlog task edit 42 -l backend,api`       |
| Set priority     | `backlog task edit 42 --priority high`      |

### Acceptance Criteria Management

| Action              | Command                                                                     |
|---------------------|-----------------------------------------------------------------------------|
| Add AC              | `backlog task edit 42 --ac "New criterion" --ac "Another"`                  |
| Remove AC #2        | `backlog task edit 42 --remove-ac 2`                                        |
| Remove multiple ACs | `backlog task edit 42 --remove-ac 2 --remove-ac 4`                          |
| Check AC #1         | `backlog task edit 42 --check-ac 1`                                         |
| Check multiple ACs  | `backlog task edit 42 --check-ac 1 --check-ac 3`                            |
| Uncheck AC #3       | `backlog task edit 42 --uncheck-ac 3`                                       |
| Mixed operations    | `backlog task edit 42 --check-ac 1 --uncheck-ac 2 --remove-ac 3 --ac "New"` |

### Task Content

| Action           | Command                                                  |
|------------------|----------------------------------------------------------|
| Add plan         | `backlog task edit 42 --plan "1. Step one\n2. Step two"` |
| Add notes        | `backlog task edit 42 --notes "Implementation details"`  |
| Add dependencies | `backlog task edit 42 --dep task-1 --dep task-2`         |

### Multi‑line Input (Description/Plan/Notes)

The CLI preserves input literally. Shells do not convert `\n` inside normal quotes. Use one of the following to insert real newlines:

- Bash/Zsh (ANSI‑C quoting):
  - Description: `backlog task edit 42 --desc $'Line1\nLine2\n\nFinal'`
  - Plan: `backlog task edit 42 --plan $'1. A\n2. B'`
  - Notes: `backlog task edit 42 --notes $'Done A\nDoing B'`
  - Append notes: `backlog task edit 42 --append-notes $'Progress update line 1\nLine 2'`
- POSIX portable (printf):
  - `backlog task edit 42 --notes "$(printf 'Line1\nLine2')"`
- PowerShell (backtick n):
  - `backlog task edit 42 --notes "Line1`nLine2"`

Do not expect `"...\n..."` to become a newline. That passes the literal backslash + n to the CLI by design.

Descriptions support literal newlines; shell examples may show escaped `\\n`, but enter a single `\n` to create a newline.

### Implementation Notes Formatting

- Keep implementation notes human-friendly and PR-ready: use short paragraphs or
  bullet lists instead of a single long line.
- Lead with the outcome, then add supporting details (e.g., testing, follow-up
  actions) on separate lines or bullets.
- Prefer Markdown bullets (`-` for unordered, `1.` for ordered) so Maintainers
  can paste notes straight into GitHub without additional formatting.
- When using CLI flags like `--append-notes`, remember to include explicit
  newlines. Example:

  ```bash
  backlog task edit 42 --append-notes $'- Added new API endpoint\n- Updated tests\n- TODO: monitor staging deploy'
  ```

### Task Operations

| Action             | Command                                      |
|--------------------|----------------------------------------------|
| View task          | `backlog task 42 --plain`                    |
| List tasks         | `backlog task list --plain`                  |
| Search tasks       | `backlog search "topic" --plain`              |
| Search with filter | `backlog search "api" --status "To Do" --plain` |
| Filter by status   | `backlog task list -s "In Progress" --plain` |
| Filter by assignee | `backlog task list -a @sara --plain`         |
| Archive task       | `backlog task archive 42`                    |
| Demote to draft    | `backlog task demote 42`                     |

---

## Common Issues

| Problem              | Solution                                                           |
|----------------------|--------------------------------------------------------------------|
| Task not found       | Check task ID with `backlog task list --plain`                     |
| AC won't check       | Use correct index: `backlog task 42 --plain` to see AC numbers     |
| Changes not saving   | Ensure you're using CLI, not editing files                         |
| Metadata out of sync | Re-edit via CLI to fix: `backlog task edit 42 -s <current-status>` |

---

## Remember: The Golden Rule

**🎯 If you want to change ANYTHING in a task, use the `backlog task edit` command.**
**📖 Use CLI to read tasks, exceptionally READ task files directly, never WRITE to them.**

Full help available: `backlog --help`

<!-- BACKLOG.MD GUIDELINES END -->

/Users/howznguyen/Workspaces/Knowns/knowns/src/templates/knowns-guidelines-cli.md

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
knowns doc "README" --plain                # Project overview
knowns doc "ARCHITECTURE" --plain          # System design
knowns doc "CONVENTIONS" --plain           # Coding standards
knowns doc "API" --plain                   # API specifications

# 3. Review current task backlog
knowns task list --plain
knowns task list --status in-progress --plain
```

### Before Taking Any Task

```bash
# 1. View the task details
knowns task <id> --plain

# 2. Follow ALL refs in the task (see Reference System section)
# @.knowns/tasks/task-44 - ... → knowns task 44 --plain
# @.knowns/docs/patterns/module.md → knowns doc "patterns/module" --plain

# 3. Search for additional related documentation
knowns search "<keywords from task>" --type doc --plain

# 4. Read ALL related docs before planning
knowns doc "<related-doc>" --plain

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

| Type | When Writing (Input) | When Reading (Output) | CLI Command |
|------|---------------------|----------------------|-------------|
| **Task ref** | `@task-<id>` | `@.knowns/tasks/task-<id> - <title>.md` | `knowns task <id> --plain` |
| **Doc ref** | `@doc/<path>` | `@.knowns/docs/<path>.md` | `knowns doc <path> --plain` |

> **CRITICAL for AI Agents**:
> - When **WRITING** refs (in descriptions, plans, notes): Use `@task-<id>` and `@doc/<path>`
> - When **READING** output from `--plain`: You'll see `@.knowns/tasks/...` and `@.knowns/docs/...`
> - **NEVER write** the output format (`@.knowns/...`) - always use input format (`@task-<id>`, `@doc/<path>`)

### How to Follow Refs

When you read a task and see refs in system output format, follow them:

```bash
# Example: Task 42 output contains:
# @.knowns/tasks/task-44 - CLI Task Create Command.md
# @.knowns/docs/patterns/module.md

# Follow task ref (extract ID from task-<id>)
knowns task 44 --plain

# Follow doc ref (extract path, remove .md)
knowns doc "patterns/module" --plain
```

### Parsing Rules

1. **Task refs**: `@.knowns/tasks/task-<id> - ...` → extract `<id>` → `knowns task <id> --plain`
2. **Doc refs**: `@.knowns/docs/<path>.md` → extract `<path>` → `knowns doc "<path>" --plain`

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
$ knowns task 42 --plain

# Output contains:
# @.knowns/tasks/task-44 - CLI Task Create Command.md
# @.knowns/docs/README.md

# 2. Follow task ref
$ knowns task 44 --plain

# 3. Follow doc ref
$ knowns doc "README" --plain

# 4. If README contains more refs, follow them too
# @.knowns/docs/patterns/module.md → knowns doc "patterns/module" --plain

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
knowns task <id> --plain                    # Shorthand
knowns task view <id> --plain               # Full command

# View doc (ALWAYS use --plain for AI)
knowns doc <path> --plain                   # Shorthand
knowns doc view "<path>" --plain            # Full command

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
$ knowns doc "README" --plain
$ knowns doc "ARCHITECTURE" --plain
$ knowns doc "CONVENTIONS" --plain

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

# 2. Take the task and start timer (uses defaultAssignee or @me fallback)
$ knowns task edit AUTH-042 -s in-progress -a $(knowns config get defaultAssignee --plain || echo "@me")
$ knowns time start AUTH-042

# Output: Timer started for AUTH-042

# 3. Search for related documentation
$ knowns search "password security" --type doc --plain

# Output:
# DOC: security-patterns.md (score: 0.92)
# DOC: email-templates.md (score: 0.78)

# 4. Read the documentation
$ knowns doc "security-patterns" --plain

# 5. Create implementation plan (SHARE WITH USER, WAIT FOR APPROVAL)
$ knowns task edit AUTH-042 --plan $'1. Review security patterns (see @doc/security-patterns)
2. Design token generation with 1-hour expiry
3. Create email template (see @doc/email-templates)
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
# Assign using defaultAssignee from config (falls back to @me if not set)
knowns task edit <id> -s in-progress -a $(knowns config get defaultAssignee --plain || echo "@me")
```

> **Note**: The `defaultAssignee` is configured in `.knowns/config.json` during `knowns init`. If not set, `@me` is used as fallback. To update: `knowns config set defaultAssignee "@username"`

### Step 2: Start Time Tracking (REQUIRED)

```bash
knowns time start <id>
```

> **CRITICAL**: Time tracking is MANDATORY. Always start timer when taking a task and stop when done. This data is essential for:
> - Accurate project estimation
> - Identifying bottlenecks
> - Resource planning
> - Sprint retrospectives

### Step 3: Read Related Documentation

> **FOR AI AGENTS**: This step is MANDATORY, not optional. You must understand the codebase before planning.

```bash
# Search for related docs
knowns search "authentication" --type doc --plain

# View relevant documents
knowns doc "API Guidelines" --plain
knowns doc "Security Patterns" --plain

# Also check for similar completed tasks
knowns search "auth" --type task --status done --plain
```

> **CRITICAL**: ALWAYS read related documentation BEFORE planning! Understanding existing patterns and conventions prevents rework and ensures consistency.

### Step 4: Create Implementation Plan

```bash
knowns task edit <id> --plan $'1. Research patterns (see @doc/security-patterns)
2. Design middleware
3. Implement
4. Add tests
5. Update docs'
```

> **CRITICAL**:
> - Share plan with user and **WAIT for approval** before coding
> - Include doc references using `@doc/<path>` format

### Step 5: Implement

```bash
# Work through implementation plan step by step
# IMPORTANT: Only check AC AFTER completing the work, not before

# After completing work for AC #1:
knowns task edit <id> --check-ac 1
knowns task edit <id> --append-notes "✓ Completed: <brief description>"

# After completing work for AC #2:
knowns task edit <id> --check-ac 2
knowns task edit <id> --append-notes "✓ Completed: <brief description>"
```

> **CRITICAL**: Never check an AC before the work is actually done. ACs represent completed outcomes, not intentions.

### Step 6: Handle Dynamic Requests (During Implementation)

If the user adds new requirements during implementation:

```bash
# Add new acceptance criteria
knowns task edit <id> --ac "New requirement from user"

# Update implementation plan to include new steps
knowns task edit <id> --plan $'1. Original step 1
2. Original step 2
3. NEW: Handle user request for X
4. Continue with remaining work'

# Append note about scope change
knowns task edit <id> --append-notes "⚠️ Scope updated: Added requirement for X per user request"

# Continue with Step 5 (Implement) for new requirements
```

> **Note**: Always document scope changes. This helps track why a task took longer than expected.

### Step 7: Add Implementation Notes

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

### Step 8: Stop Time Tracking (REQUIRED)

```bash
knowns time stop
```

> **CRITICAL**: Never forget to stop the timer. If you forget, use manual entry: `knowns time add <id> <duration> -n "Forgot to stop timer"`

### Step 9: Complete Task

```bash
knowns task edit <id> -s done
```

### Step 10: Handle Post-Completion Changes (If Applicable)

If the user requests changes or updates AFTER task is marked done:

```bash
# 1. Reopen task - set back to in-progress
knowns task edit <id> -s in-progress

# 2. Restart time tracking (REQUIRED)
knowns time start <id>

# 3. Add new AC for the changes requested
knowns task edit <id> --ac "Post-completion fix: <description>"

# 4. Document the reopen reason
knowns task edit <id> --append-notes "🔄 Reopened: User requested changes - <reason>"

# 5. Follow Step 5-9 again (Implement → Notes → Stop Timer → Done)
```

> **CRITICAL**: Treat post-completion changes as a mini-workflow. Always:
> - Reopen task (in-progress)
> - Start timer again
> - Add AC for traceability
> - Document why it was reopened
> - Follow the same completion process

### Step 11: Knowledge Extraction (Post-Completion)

After completing a task, extract reusable knowledge to docs:

```bash
# Search if similar pattern already documented
knowns search "<pattern/concept>" --type doc --plain

# If new knowledge, create a doc for future reference
knowns doc create "Pattern: <Name>" \
    -d "Reusable pattern discovered during task implementation" \
    -t "pattern,<domain>" \
    -f "patterns"

# Or append to existing doc
knowns doc edit "<existing-doc>" -a "## New Section\n\nLearned from task <id>: ..."

# Reference the source task
knowns doc edit "<doc-name>" -a "\n\n> Source: @task-<id>"
```

**When to extract knowledge:**
- New patterns/conventions discovered
- Common error solutions
- Reusable code snippets or approaches
- Integration patterns with external services
- Performance optimization techniques

> **CRITICAL**: Only extract **generalizable** knowledge. Task-specific details belong in implementation notes, not docs.

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
knowns task edit <id> -a <assignee>              # $(knowns config get defaultAssignee --plain || echo "@me")

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
knowns task <id> --plain                             # Shorthand (ALWAYS use --plain)
knowns task view <id> --plain                        # Full command
knowns task list --plain
knowns task list --status in-progress --plain
knowns task list --assignee <assignee> --plain   # $(knowns config get defaultAssignee --plain || echo "@me")
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
knowns doc <path> --plain                          # Shorthand (ALWAYS use --plain)
knowns doc view "<path>" --plain                   # Full command

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

Explains WHY and WHAT (not HOW). **Link related docs using `@doc/<path>`**

```markdown
We need JWT authentication because sessions don't scale for our microservices architecture.

Related docs: @doc/security-patterns, @doc/api-guidelines
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
1. Research JWT libraries (see @doc/security-patterns)
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
| `Error: AC index out of range` | Checking non-existent criterion | View task first: `knowns task <id> --plain` |
| `Error: Document not found` | Wrong document name | Run `knowns doc list --plain` to find correct name |
| `Error: Not initialized` | Running commands without init | Run `knowns init` first |

### Debugging Commands

```bash
# Check CLI version
knowns --version

# Verify project is initialized
knowns status

# View raw task data (for debugging)
knowns task <id> --json

# Check timer status
knowns time status
```

---

## Definition of Done

A task is **Done** ONLY when **ALL** criteria are met:

### Via CLI (Required)

- [ ] All acceptance criteria checked: `--check-ac <index>` (only after work is actually done)
- [ ] Implementation notes added: `--notes "..."`
- [ ] ⏱️ Timer stopped: `knowns time stop` (MANDATORY - do not skip!)
- [ ] Status set to done: `-s done`
- [ ] Knowledge extracted to docs (if applicable)

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
| Check AC before completing work | Only check AC AFTER work is actually done |
| Skip time tracking | ALWAYS use `time start` and `time stop` |
| Start coding without reading docs | Read ALL related docs FIRST |
| Skip `knowns doc list` on new project | Always list docs when starting |
| Assume you know the conventions | Read CONVENTIONS/ARCHITECTURE docs |
| Plan without checking docs | Read docs before planning |
| Ignore similar completed tasks | Search done tasks for patterns |
| Missing doc links in description/plan | Link docs using `@doc/<path>` |
| Write refs as `@.knowns/docs/...` or `@.knowns/tasks/...` | Use input format: `@doc/<path>`, `@task-<id>` |
| Forget `--plain` flag | Always use `--plain` for AI |
| Code before plan approval | Share plan, WAIT for approval |
| Mark done without all criteria | Check ALL criteria first |
| Write implementation steps in AC | Write outcome-oriented criteria |
| Use `"In Progress"` or `"Done"` | Use `in-progress`, `done` |
| Use `@yourself` or unknown assignee | Use `$(knowns config get defaultAssignee --plain \|\| echo "@me")` |
| Ignore refs in task description | Follow ALL refs (`@.knowns/...`) before planning |
| See `@.knowns/docs/...` but don't read | Use `knowns doc "<path>" --plain` |
| See `@.knowns/tasks/task-X` but don't check | Use `knowns task X --plain` for context |
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

### Windows Command Line Limit

Windows has ~8191 character limit. For long content, append in chunks:

```bash
# 1. Create or reset with short content
knowns doc edit "doc-name" -c "## Overview\n\nShort intro."

# 2. Append each section separately
knowns doc edit "doc-name" -a "## Section 1\n\nContent..."
knowns doc edit "doc-name" -a "## Section 2\n\nMore content..."
```

Or use file-based options:

```bash
knowns doc edit "doc-name" --content-file ./content.md
knowns doc edit "doc-name" --append-file ./more.md
```

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
- [ ] ALL relevant docs read: `knowns doc "Doc Name" --plain`
- [ ] Similar done tasks reviewed for patterns
- [ ] Task assigned to self: `-a $(knowns config get defaultAssignee --plain || echo "@me")`
- [ ] Status set to in-progress: `-s in-progress`
- [ ] Timer started: `knowns time start <id>`

### During Work

- [ ] Implementation plan created and approved
- [ ] Doc links included in plan: `@doc/<path>`
- [ ] Criteria checked as completed: `--check-ac <index>`
- [ ] Progress notes appended: `--append-notes "✓ ..."`

### After Work

- [ ] All acceptance criteria checked (only after work is done)
- [ ] Implementation notes added: `--notes "..."`
- [ ] Timer stopped: `knowns time stop`
- [ ] Tests passing
- [ ] Documentation updated
- [ ] Status set to done: `-s done`
- [ ] Knowledge extracted to docs (if applicable): patterns, solutions, conventions

---

## Quick Reference Card

```bash
# === AGENT INITIALIZATION (Once per session) ===
knowns doc list --plain
knowns doc "README" --plain
knowns doc "ARCHITECTURE" --plain
knowns doc "CONVENTIONS" --plain

# === FULL WORKFLOW ===
knowns task create "Title" -d "Description" --ac "Criterion"
knowns task edit <id> -s in-progress -a $(knowns config get defaultAssignee --plain || echo "@me")
knowns time start <id>                                     # ⏱️ REQUIRED: Start timer
knowns search "keyword" --type doc --plain
knowns doc "Doc Name" --plain
knowns search "keyword" --type task --status done --plain  # Learn from history
knowns task edit <id> --plan $'1. Step (see @doc/file)\n2. Step'
# ... wait for approval, then implement ...
# Only check AC AFTER completing the work:
knowns task edit <id> --check-ac 1
knowns task edit <id> --append-notes "✓ Completed: feature X"
knowns task edit <id> --check-ac 2
knowns task edit <id> --append-notes "✓ Completed: feature Y"
knowns time stop                                           # ⏱️ REQUIRED: Stop timer
knowns task edit <id> -s done
# Optional: Extract knowledge to docs if generalizable patterns found

# === VIEW & SEARCH ===
knowns task <id> --plain                                   # Shorthand for view
knowns task list --plain
knowns task list --status in-progress --assignee $(knowns config get defaultAssignee --plain || echo "@me") --plain
knowns search "query" --plain
knowns search "bug" --type task --status in-progress --plain

# === TIME TRACKING ===
knowns time start <id>
knowns time stop
knowns time status
knowns time report --from "2025-12-01" --to "2025-12-31"

# === DOCUMENTATION ===
knowns doc list --plain
knowns doc "path/doc-name" --plain                         # Shorthand for view
knowns doc create "Title" -d "Description" -t "tags" -f "folder"
knowns doc edit "doc-name" -c "New content"
knowns doc edit "doc-name" -a "Appended content"
```

---

**Maintained By**: Knowns CLI Team

<!-- KNOWNS GUIDELINES END -->










