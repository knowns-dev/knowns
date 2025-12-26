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



