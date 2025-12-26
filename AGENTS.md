
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

<!-- KNOWNS GUIDELINES START -->
# Knowns CLI Guidelines

## Core Principle

**NEVER edit .md files directly. ALL operations MUST use CLI commands.**

This ensures data integrity, maintains proper change history, and prevents file corruption.

---

## Table of Contents

1. [Project Structure](#project-structure)
2. [Task Management](#task-management)
3. [Time Tracking](#time-tracking)
4. [Documentation Management](#documentation-management)
5. [Search](#search)
6. [Board & Browser](#board--browser)
7. [Configuration](#configuration)
8. [Agent Instructions](#agent-instructions)
9. [Task Workflow](#task-workflow)
10. [Definition of Done](#definition-of-done)
11. [Common Mistakes](#common-mistakes)
12. [Tips & Best Practices](#tips--best-practices)

---

## Project Structure

```
.knowns/
├── tasks/              # Task files: task-<id> - <title>.md
├── docs/               # Documentation (supports nested folders)
├── time-tracking/      # Time tracking data
└── config.json         # Project configuration
```

### Initialization

```bash
# Initialize .knowns/ in current directory
knowns init [name]
```

---

## Task Management

### Task Lifecycle

1. **Create** → `knowns task create "Title" -d "Description" --ac "Criterion 1" --ac "Criterion 2"`
2. **Start** → `knowns task edit <id> -s in-progress -a @yourself`
3. **Work** → Check acceptance criteria as you complete them
4. **Complete** → Mark status as done after all criteria met
5. **Archive** → `knowns task archive <id>` (optional, for historical tasks)

### Create Task

```bash
# Basic creation
knowns task create "Implement user authentication"

# Full creation with all options
knowns task create "Add JWT authentication" \
  -d "Implement JWT-based auth to replace session cookies" \
  --ac "User can login with email/password" \
  --ac "JWT token expires after 15 minutes" \
  --ac "Refresh token works for 7 days" \
  -l "auth,security" \
  --priority high \
  -s "todo" \
  -a @backend-team

# Create subtask
knowns task create "Design auth database schema" \
  --parent 42 \
  -d "Design tables for users, tokens, sessions"
```

**Options:**
- `-d, --description <text>` - Task description (WHY and WHAT, not HOW)
- `--ac <criterion>` - Acceptance criteria (can be used multiple times)
- `-l, --labels <labels>` - Comma-separated labels (e.g., `bug,urgent`)
- `-a, --assignee <name>` - Assignee (@username or @team)
- `--priority <level>` - Priority: `low`, `medium`, `high` (default: `medium`)
- `-s, --status <status>` - Initial status (default: `todo`)
- `--parent <id>` - Parent task ID for creating subtasks

### List Tasks

```bash
# List all tasks (always use --plain for AI)
knowns task list --plain

# Filter by status
knowns task list --status in-progress --plain
knowns task list --status done --plain

# Filter by assignee
knowns task list --assignee @yourself --plain
knowns task list --assignee @backend-team --plain

# Filter by labels
knowns task list --labels "bug,urgent" --plain

# Filter by priority
knowns task list --priority high --plain

# View as tree hierarchy (shows parent-child relationships)
knowns task list --tree --plain

# Combine filters
knowns task list --status in-progress --assignee @yourself --priority high --plain
```

**Options:**
- `--status <status>` - Filter by status
- `--assignee <name>` - Filter by assignee (@username)
- `-l, --labels <labels>` - Filter by labels (comma-separated)
- `--priority <level>` - Filter by priority (low, medium, high)
- `--tree` - Display tasks as tree hierarchy
- `--plain` - Plain text output for AI (ALWAYS use this)

### View Task

```bash
# View task details (ALWAYS use --plain for AI)
knowns task view 42 --plain
```

**Output includes:**
- Task metadata (ID, title, status, priority, assignee, labels)
- Description
- Acceptance criteria (with checked/unchecked status)
- Implementation plan (if added)
- Implementation notes (if added)
- Subtasks (if any)
- Related documents

### Edit Task

```bash
# Change title
knowns task edit 42 -t "New title"

# Change description
knowns task edit 42 -d "Updated description"
knowns task edit 42 -d $'Multi-line\nDescription\nHere'

# Change status
knowns task edit 42 -s in-progress
knowns task edit 42 -s done

# Change priority
knowns task edit 42 --priority high

# Assign to someone
knowns task edit 42 -a @yourself
knowns task edit 42 -a @backend-team

# Update labels
knowns task edit 42 -l "bug,critical,security"

# Move to different parent (or remove parent)
knowns task edit 42 --parent 10
knowns task edit 42 --parent none

# === Acceptance Criteria ===

# Add new acceptance criterion
knowns task edit 42 --ac "New criterion"
knowns task edit 42 --ac "First" --ac "Second" --ac "Third"

# Check acceptance criteria (mark as done)
knowns task edit 42 --check-ac 1
knowns task edit 42 --check-ac 1 --check-ac 2 --check-ac 3

# Uncheck acceptance criteria
knowns task edit 42 --uncheck-ac 2

# Remove acceptance criteria
knowns task edit 42 --remove-ac 3

# Mixed operations work together
knowns task edit 42 --check-ac 1 --uncheck-ac 2 --remove-ac 3 --ac "New one"

# === Implementation Plan ===

# Add implementation plan (HOW to solve)
knowns task edit 42 --plan $'1. Research JWT libraries\n2. Implement middleware\n3. Add tests'

# === Implementation Notes ===

# Set implementation notes (replaces existing)
knowns task edit 42 --notes $'Implemented using jsonwebtoken library\nAdded tests in auth.test.ts\nReady for review'

# Append to implementation notes (progressive updates)
knowns task edit 42 --append-notes "Completed authentication middleware"
knowns task edit 42 --append-notes "Added integration tests"
knowns task edit 42 --append-notes "Updated documentation"
```

**Options:**
- `-t, --title <text>` - New title
- `-d, --description <text>` - New description
- `-s, --status <status>` - New status
- `--priority <level>` - New priority (low, medium, high)
- `-l, --labels <labels>` - Comma-separated labels
- `-a, --assignee <name>` - Assignee (@username)
- `--parent <id>` - Move to new parent (use 'none' to remove parent)
- `--ac <text>` - Add new acceptance criterion (can be used multiple times)
- `--check-ac <index>` - Check AC by index (1-based, can be used multiple times)
- `--uncheck-ac <index>` - Uncheck AC by index (can be used multiple times)
- `--remove-ac <index>` - Remove AC by index (can be used multiple times)
- `--plan <text>` - Set implementation plan
- `--notes <text>` - Set implementation notes (replaces existing)
- `--append-notes <text>` - Append to implementation notes

### Task History & Versioning

```bash
# View task change history
knowns task history 42 --plain

# View last N changes
knowns task history 42 --limit 5 --plain

# Compare current version with previous version
knowns task diff 42

# Compare specific versions
knowns task diff 42 --from v1 --to v3

# Restore task to previous version
knowns task restore 42 --version v2

# Preview restore without applying
knowns task restore 42 --version v2 --preview
```

**Options for history:**
- `--limit <n>` - Show last N changes
- `--plain` - Plain text output for AI

**Options for diff:**
- `--from <version>` - Compare from version
- `--to <version>` - Compare to version (default: current)

**Options for restore:**
- `--version <version>` - Version to restore to
- `--preview` - Show what would change without applying

### Archive & Unarchive

```bash
# Archive completed task
knowns task archive 42

# Restore archived task
knowns task unarchive 42
```

### Multi-line Input (Shell-specific)

**Bash/Zsh** - Use `$'...\n...'`:
```bash
knowns task edit 42 --desc $'Line 1\nLine 2\n\nLine 3'
knowns task edit 42 --plan $'1. First step\n2. Second step\n3. Third step'
knowns task edit 42 --notes $'Done A\nDoing B\nNext: C'
```

**PowerShell** - Use backtick-n:
```powershell
knowns task edit 42 --notes "Line1`nLine2`nLine3"
```

**Portable** - Use printf:
```bash
knowns task edit 42 --notes "$(printf 'Line1\nLine2\nLine3')"
```

---

## Time Tracking

Track time spent on tasks for better project management and reporting.

### Basic Commands

```bash
# Start timer for a task
knowns time start 42

# Stop current timer and save time entry
knowns time stop

# Pause current timer
knowns time pause

# Resume paused timer
knowns time resume

# Check active timer status
knowns time status
```

### Manual Time Entry

```bash
# Add time entry manually
knowns time add 42 2h

# With note and custom date
knowns time add 42 1h30m \
  -n "Fixed authentication bug" \
  -d "2025-12-25"
```

**Duration format:**
- `2h` - 2 hours
- `30m` - 30 minutes
- `1h30m` - 1 hour 30 minutes

**Options:**
- `-n, --note <text>` - Note for this time entry
- `-d, --date <date>` - Date for time entry (YYYY-MM-DD, default: now)

### View Time Log

```bash
# Show time log for a task
knowns time log 42
```

### Time Reports

```bash
# Generate time report for date range
knowns time report --from "2025-12-01" --to "2025-12-31"

# Group by label
knowns time report --by-label

# Group by status
knowns time report --by-status

# Export as CSV
knowns time report --csv > report.csv

# Combine options
knowns time report \
  --from "2025-12-01" \
  --to "2025-12-31" \
  --by-label \
  --csv > december-report.csv
```

**Options:**
- `--from <date>` - Start date (YYYY-MM-DD)
- `--to <date>` - End date (YYYY-MM-DD)
- `--by-label` - Group by label
- `--by-status` - Group by status
- `--csv` - Export as CSV

---

## Documentation Management

### Commands

```bash
# List all docs (includes nested folders)
knowns doc list --plain

# Filter by tag
knowns doc list --tag architecture --plain

# View document (by name, title, or path)
knowns doc view <name> --plain
knowns doc view "API Guidelines" --plain
knowns doc view patterns/guards --plain
knowns doc view patterns/guards.md --plain

# Create document
knowns doc create "API Design Guidelines" \
  -d "Guidelines for designing REST APIs" \
  -t "api,guidelines,architecture"

# Edit document metadata
knowns doc edit "API Guidelines" \
  -t "REST API Design Guidelines" \
  -d "Updated description" \
  --tags "api,rest,design"
```

**Create options:**
- `-d, --description <text>` - Document description
- `-t, --tags <tags>` - Comma-separated tags
- `--plain` - Plain text output for AI

**Edit options:**
- `-t, --title <text>` - New title
- `-d, --description <text>` - New description
- `--tags <tags>` - Comma-separated tags

**List options:**
- `--plain` - Plain text output for AI
- `-t, --tag <tag>` - Filter by tag

### Document Links

In `--plain` mode, markdown links are replaced with resolved paths:
- `[guards.md](./patterns/guards.md)` → `@.knowns/docs/patterns/guards.md`

This allows AI agents to easily reference and read related documentation.

---

## Search

Powerful full-text search across tasks and documentation.

```bash
# Search everything (tasks + docs)
knowns search "authentication" --plain

# Search tasks only
knowns search "login bug" --type task --plain

# Search docs only
knowns search "API guidelines" --type doc --plain

# Search with status filter
knowns search "authentication" --status in-progress --plain

# Search with label filter
knowns search "bug" --label critical --plain

# Search with assignee filter
knowns search "performance" --assignee @backend-team --plain

# Search with priority filter
knowns search "security" --priority high --plain

# Combine multiple filters
knowns search "authentication" \
  --type task \
  --status in-progress \
  --assignee @yourself \
  --priority high \
  --plain
```

**Options:**
- `--type <type>` - Search type: `task`, `doc`, or `all` (default: `all`)
- `--status <status>` - Filter tasks by status
- `-l, --label <label>` - Filter tasks by label
- `--assignee <name>` - Filter tasks by assignee
- `--priority <level>` - Filter tasks by priority
- `--plain` - Plain text output for AI (ALWAYS use this)

---

## Board & Browser

### Kanban Board

Display tasks in a Kanban board view (Todo, In Progress, Done, etc.)

```bash
# Display kanban board (always use --plain for AI)
knowns board --plain

# Filter by status
knowns board --status in-progress --plain

# Filter by assignee
knowns board --assignee @yourself --plain

# Combine filters
knowns board --status in-progress --assignee @yourself --plain
```

**Options:**
- `--plain` - Plain text output for AI
- `--status <status>` - Filter by status
- `--assignee <name>` - Filter by assignee

### Web Browser UI

Open interactive web UI for task management (for human users).

```bash
# Open web UI
knowns browser

# Open on specific port
knowns browser --port 3000

# Open with specific host
knowns browser --host 0.0.0.0 --port 8080
```

**Note:** Browser UI is for human interaction. AI agents should use CLI commands with `--plain` flag.

---

## Configuration

Manage project-level configuration settings.

```bash
# List all configuration settings
knowns config list --plain

# Get specific configuration value
knowns config get <key> --plain

# Set configuration value
knowns config set defaultAssignee "@backend-team"
knowns config set defaultPriority "high"

# Reset configuration to defaults
knowns config reset

# Reset specific key
knowns config reset defaultAssignee
```

**Common configuration keys:**
- `defaultAssignee` - Default assignee for new tasks
- `defaultPriority` - Default priority for new tasks
- `defaultStatus` - Default status for new tasks
- `timeTrackingEnabled` - Enable/disable time tracking

---

## Agent Instructions

Manage agent instruction files (CLAUDE.md, AGENTS.md, etc.)

```bash
# Update agent instruction files with latest guidelines
knowns agents --update-instructions
```

This command automatically updates:
- `CLAUDE.md` - Claude Code agent instructions
- `AGENTS.md` - Multi-agent collaboration instructions
- Other agent-specific instruction files

The instructions include the latest version of these Knowns CLI Guidelines.

---

## Task Workflow

### Step 1: Take Task

```bash
# Assign task to yourself and set status to in-progress
knowns task edit 42 -s in-progress -a @yourself
```

### Step 2: Create Implementation Plan

```bash
# Add detailed implementation plan
knowns task edit 42 --plan $'1. Research existing authentication patterns\n2. Design JWT middleware\n3. Implement token generation/validation\n4. Add tests\n5. Update documentation'
```

**CRITICAL**: Share plan with user and **WAIT for approval** before coding.

### Step 3: Implement

Write code following the implementation plan, then check acceptance criteria as you complete them:

```bash
# Check criteria as you complete each one
knowns task edit 42 --check-ac 1
knowns task edit 42 --check-ac 2
knowns task edit 42 --check-ac 3

# Or check multiple at once
knowns task edit 42 --check-ac 1 --check-ac 2 --check-ac 3
```

### Step 4: Add Implementation Notes

```bash
# Add comprehensive notes (suitable for PR description)
knowns task edit 42 --notes $'## Implementation Summary\n\nImplemented JWT authentication using jsonwebtoken library.\n\n## Changes\n- Added JWT middleware in src/middleware/auth.ts\n- Updated login endpoint to return tokens\n- Added token refresh endpoint\n\n## Testing\n- Unit tests in tests/auth.test.ts\n- Integration tests in tests/api/auth.test.ts\n- All tests passing\n\n## Documentation\n- Updated API.md with new endpoints\n- Added authentication guide in docs/auth.md'
```

Or append progressively as you work:

```bash
knowns task edit 42 --append-notes "✓ Implemented JWT middleware"
knowns task edit 42 --append-notes "✓ Added unit tests (100% coverage)"
knowns task edit 42 --append-notes "✓ Added integration tests"
knowns task edit 42 --append-notes "✓ Updated documentation"
```

### Step 5: Complete Task

```bash
# Mark as done (only after ALL criteria are met)
knowns task edit 42 -s done
```

### Step 6: Optional - Archive

```bash
# Archive task after completion (optional)
knowns task archive 42
```

---

## Definition of Done

A task is **Done** ONLY when **ALL** of the following are complete:

### Via CLI (Required)

1. ✅ **All acceptance criteria checked**: `--check-ac <index>` for each criterion
2. ✅ **Implementation notes added**: `--notes "..."` with comprehensive summary
3. ✅ **Status set to done**: `-s done`

### Via Code (Required)

4. ✅ **Tests pass**: All unit, integration, and E2E tests passing
5. ✅ **Documentation updated**: README, API docs, comments updated
6. ✅ **Code reviewed**: Code meets quality standards (linting, formatting)
7. ✅ **No regressions**: Existing functionality still works

### Verification Checklist

Before marking a task as Done, verify:

```bash
# 1. Check all acceptance criteria are checked
knowns task view 42 --plain | grep "Acceptance Criteria"

# 2. Verify implementation notes exist
knowns task view 42 --plain | grep "Implementation Notes"

# 3. Run tests
bun test  # or npm test, yarn test, etc.

# 4. Run linter
bun run lint

# 5. Build project
bun run build

# 6. Review changes
git diff

# 7. Only then mark as done
knowns task edit 42 -s done
```

---

## Task Structure

### Title
Brief, clear summary of the task (WHAT needs to be done).

**Good:**
- "Add JWT authentication"
- "Fix login timeout bug"
- "Optimize database queries"

**Bad:**
- "Do auth stuff"
- "Fix bug"
- "Make it faster"

### Description
Explains **WHY** and **WHAT** (not HOW). Provides context and background.

**Good:**
```
We need to replace session-based authentication with JWT tokens because:
1. Sessions don't scale well with multiple server instances
2. JWT tokens are stateless and work better with our microservices architecture
3. Mobile apps need token-based auth

This task will implement JWT authentication for the login endpoint.
```

**Bad:**
```
Add JWT auth.
```

### Acceptance Criteria
**Outcome-oriented**, testable, user-focused criteria. NOT implementation details.

**Good (Outcome-oriented):**
- ✅ "User can login with email/password and receive JWT token"
- ✅ "JWT token expires after 15 minutes"
- ✅ "Refresh token works for 7 days"
- ✅ "Invalid tokens return 401 Unauthorized"
- ✅ "System processes 1000 requests/sec without errors"

**Bad (Implementation details):**
- ❌ "Add function `handleLogin()` in `auth.ts`"
- ❌ "Install jsonwebtoken package"
- ❌ "Create JWT middleware"

**Why?** Acceptance criteria define WHAT success looks like, not HOW to achieve it.

### Implementation Plan (added during work)
**HOW** to solve the task. Added **AFTER** taking the task, **BEFORE** coding.

**Example:**
```
1. Research JWT libraries (jsonwebtoken vs jose)
2. Design token structure (claims, expiry)
3. Implement token generation in login endpoint
4. Create JWT validation middleware
5. Add token refresh endpoint
6. Write unit tests (token generation, validation)
7. Write integration tests (login flow, protected routes)
8. Update API documentation
```

### Implementation Notes (PR description)
Summary of what was done, suitable for PR. Added **AFTER** completion.

**Example:**
```
## Implementation Summary

Implemented JWT authentication using jsonwebtoken library.

## Changes
- Added JWT middleware in src/middleware/auth.ts
- Updated login endpoint to return access + refresh tokens
- Added token refresh endpoint at POST /auth/refresh
- Added token revocation support

## Testing
- Unit tests: src/middleware/auth.test.ts (100% coverage)
- Integration tests: tests/api/auth.test.ts
- Manual testing: Postman collection updated

## Documentation
- Updated API.md with new endpoints
- Added authentication guide in docs/auth.md
- Updated .env.example with JWT_SECRET

## Performance
- Benchmarked at 5000 req/sec (vs 1000 req/sec with sessions)

## Security
- Tokens signed with HS256
- Refresh tokens stored in httpOnly cookies
- Access tokens expire in 15 minutes
- Refresh tokens expire in 7 days
```

---

## Common Mistakes

| ❌ Wrong | ✅ Right |
|---------|---------|
| Edit .md files directly | Use `knowns task edit` |
| Change `- [ ]` to `- [x]` in file | Use `--check-ac <index>` |
| Add implementation plan during creation | Add plan when starting work (`knowns task edit --plan`) |
| Mark done without checking all criteria | Check ALL criteria first (`--check-ac`) |
| Mark done without implementation notes | Add notes with `--notes` before marking done |
| Write implementation details in acceptance criteria | Write outcome-oriented criteria |
| Forget to use `--plain` flag | Always use `--plain` for AI-readable output |
| Forget to share plan before coding | Share plan, WAIT for approval, then code |
| Create task without acceptance criteria | Always include `--ac` when creating tasks |
| Implement features not in acceptance criteria | Update AC first, or create new task |
| Use `"In Progress"` or `"Done"` | Use lowercase with hyphens: `in-progress`, `done` |

---

## Tips & Best Practices

### General
- ✅ **Always use `--plain` flag** for AI-readable output
- ✅ **Read task before editing**: `knowns task view <id> --plain`
- ✅ **Use descriptive titles**: "Add JWT auth" not "Do auth"
- ✅ **Write outcome-oriented acceptance criteria**: Focus on WHAT, not HOW
- ✅ **Share plan before coding**: Get approval first, then implement
- ✅ **Check criteria as you go**: Don't wait until the end
- ✅ **Add notes progressively**: Use `--append-notes` as you work

### Acceptance Criteria
- ✅ **Multiple values work**: `--check-ac 1 --check-ac 2 --check-ac 3`
- ✅ **Mixed operations work**: `--check-ac 1 --uncheck-ac 2 --remove-ac 3`
- ✅ **Add criteria anytime**: `--ac "New criterion"`

### Multi-line Input
- ✅ **Bash/Zsh**: Use `$'...\n...'` for multi-line
- ✅ **PowerShell**: Use backtick-n (`\`n`)
- ✅ **Portable**: Use `printf` for cross-platform

### Documentation
- ✅ **Related docs show as paths**: `@.knowns/docs/path/to/file.md` in plain mode
- ✅ **Use tags for organization**: `-t "api,guidelines,architecture"`
- ✅ **Link docs in task descriptions**: Reference related documentation

### Time Tracking
- ✅ **Start timer when you start work**: `knowns time start <id>`
- ✅ **Stop timer when you take a break**: `knowns time stop`
- ✅ **Add manual entries for past work**: `knowns time add <id> 2h -d "2025-12-25"`
- ✅ **Generate reports regularly**: Track project progress

### Search
- ✅ **Use specific queries**: "JWT authentication bug" not "auth"
- ✅ **Combine filters**: `--type task --status in-progress --priority high`
- ✅ **Search before creating**: Avoid duplicate tasks

### Task Organization
- ✅ **Use labels for categorization**: `bug`, `feature`, `urgent`, `technical-debt`
- ✅ **Use priority correctly**: Reserve `high` for truly urgent items
- ✅ **Create subtasks for large tasks**: `--parent <id>`
- ✅ **Archive completed tasks**: Keep active list clean

### Workflow
- ✅ **One task at a time**: Don't start multiple tasks
- ✅ **Update status promptly**: Keep task status current
- ✅ **Review before marking done**: Use Definition of Done checklist
- ✅ **Version control sync**: Commit code, update task

---

## Full Help

```bash
# General help
knowns --help

# Command-specific help
knowns task --help
knowns task create --help
knowns task edit --help
knowns task list --help
knowns task view --help

knowns time --help
knowns time report --help

knowns doc --help
knowns doc create --help

knowns search --help
knowns board --help
knowns config --help
knowns agents --help
```

---

## Quick Reference

### Most Common Commands

```bash
# Create task
knowns task create "Title" -d "Description" --ac "Criterion"

# Take task
knowns task edit <id> -s in-progress -a @yourself

# Add plan
knowns task edit <id> --plan $'1. Step\n2. Step'

# Check criteria
knowns task edit <id> --check-ac 1 --check-ac 2

# Add notes
knowns task edit <id> --notes "Implementation summary"

# Mark done
knowns task edit <id> -s done

# View task
knowns task view <id> --plain

# List tasks
knowns task list --plain

# Search
knowns search "query" --plain
```

### Status Values

Valid status values:
- `todo` - Not started
- `in-progress` - Currently working
- `in-review` - In code review
- `done` - Completed
- `blocked` - Waiting on dependency

### Priority Values

- `low` - Can wait
- `medium` - Normal priority (default)
- `high` - Urgent, important

---

**Last Updated**: 2025-12-26
**Version**: 2.0.0
**Maintained By**: Knowns CLI Team

<!-- KNOWNS GUIDELINES END -->






