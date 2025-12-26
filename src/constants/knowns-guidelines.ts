/**
 * Knowns CLI Guidelines - System Prompt
 * This content will be injected into agent instruction files (CLAUDE.md, AGENTS.md, etc.)
 */

export const KNOWNS_GUIDELINES = `<!-- KNOWNS GUIDELINES START -->
# Knowns CLI Guidelines

## Core Principle

**NEVER edit .md files directly. ALL operations MUST use CLI commands.**

This ensures data integrity, maintains proper change history, and prevents file corruption.

---

## Quick Start

\`\`\`bash
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
\`\`\`

---

## Task Workflow (CRITICAL - Follow Every Step!)

### Step 1: Take Task
\`\`\`bash
knowns task edit <id> -s in-progress -a @yourself
\`\`\`

### Step 2: Start Time Tracking
\`\`\`bash
knowns time start <id>
\`\`\`

### Step 3: Read Related Documentation
\`\`\`bash
# Search for related docs
knowns search "authentication" --type doc --plain

# View relevant documents
knowns doc view "API Guidelines" --plain
\`\`\`

**CRITICAL**: ALWAYS read related documentation BEFORE planning!

### Step 4: Create Implementation Plan
\`\`\`bash
# Add plan with documentation references
knowns task edit <id> --plan $'1. Research patterns (see [security-patterns.md](./security-patterns.md))\\n2. Design middleware\\n3. Implement\\n4. Add tests\\n5. Update docs'
\`\`\`

**CRITICAL**:
- Share plan with user and **WAIT for approval** before coding
- Include doc references using \`[file.md](./path/file.md)\` format

### Step 5: Implement
\`\`\`bash
# Check acceptance criteria as you complete them
knowns task edit <id> --check-ac 1 --check-ac 2 --check-ac 3
\`\`\`

### Step 6: Add Implementation Notes
\`\`\`bash
# Add comprehensive notes (suitable for PR description)
knowns task edit <id> --notes $'## Summary\\n\\nImplemented JWT auth.\\n\\n## Changes\\n- Added middleware\\n- Added tests'

# OR append progressively
knowns task edit <id> --append-notes "✓ Implemented middleware"
knowns task edit <id> --append-notes "✓ Added tests"
\`\`\`

### Step 7: Stop Time Tracking
\`\`\`bash
knowns time stop
\`\`\`

### Step 8: Complete Task
\`\`\`bash
# Mark as done (only after ALL criteria are met)
knowns task edit <id> -s done
\`\`\`

---

## Essential Commands

### Task Management

\`\`\`bash
# Create task
knowns task create "Title" -d "Description" --ac "Criterion" -l "labels" --priority high

# Edit task
knowns task edit <id> -t "New title"
knowns task edit <id> -d "New description"
knowns task edit <id> -s in-progress
knowns task edit <id> --priority high
knowns task edit <id> -a @yourself

# Acceptance Criteria
knowns task edit <id> --ac "New criterion"           # Add
knowns task edit <id> --check-ac 1 --check-ac 2      # Check
knowns task edit <id> --uncheck-ac 2                 # Uncheck
knowns task edit <id> --remove-ac 3                  # Remove

# Implementation Plan & Notes
knowns task edit <id> --plan $'1. Step\\n2. Step'
knowns task edit <id> --notes "Implementation summary"
knowns task edit <id> --append-notes "Progress update"

# View & List
knowns task view <id> --plain                        # ALWAYS use --plain
knowns task list --plain
knowns task list --status in-progress --plain
knowns task list --assignee @yourself --plain
knowns task list --tree --plain                      # Tree hierarchy
\`\`\`

### Time Tracking

\`\`\`bash
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
\`\`\`

### Documentation

\`\`\`bash
# List & View
knowns doc list --plain
knowns doc list --tag architecture --plain
knowns doc view "Doc Name" --plain

# Create
knowns doc create "Title" -d "Description" -t "tags"

# Edit metadata
knowns doc edit "Doc Name" -t "New Title" --tags "new,tags"
\`\`\`

### Search

\`\`\`bash
# Search everything
knowns search "query" --plain

# Search specific type
knowns search "auth" --type task --plain
knowns search "patterns" --type doc --plain

# Filter
knowns search "bug" --status in-progress --priority high --plain
\`\`\`

---

## Task Structure

### Title
Clear summary (WHAT needs to be done).
- Good: "Add JWT authentication"
- Bad: "Do auth stuff"

### Description
Explains WHY and WHAT (not HOW). **Link related docs using \`[file.md](./path/file.md)\`**

\`\`\`
We need JWT authentication because sessions don't scale.

Related docs:
- [security-patterns.md](./security-patterns.md)
- [api-guidelines.md](./api-guidelines.md)
\`\`\`

### Acceptance Criteria
**Outcome-oriented**, testable criteria. NOT implementation details.

- Good: "User can login and receive JWT token"
- Good: "Token expires after 15 minutes"
- Bad: "Add function handleLogin() in auth.ts"

### Implementation Plan
HOW to solve. Added AFTER taking task, BEFORE coding.

\`\`\`
1. Research JWT libraries (see [security-patterns.md](./security-patterns.md))
2. Design token structure
3. Implement middleware
4. Add tests
\`\`\`

### Implementation Notes
Summary for PR. Added AFTER completion.

\`\`\`
## Summary
Implemented JWT auth using jsonwebtoken.

## Changes
- Added middleware in src/auth.ts
- Added tests with 100% coverage

## Documentation
- Updated API.md
\`\`\`

---

## Definition of Done

A task is **Done** ONLY when **ALL** criteria are met:

### Via CLI (Required)
1. All acceptance criteria checked: \`--check-ac <index>\`
2. Implementation notes added: \`--notes "..."\`
3. Status set to done: \`-s done\`

### Via Code (Required)
4. Tests pass
5. Documentation updated
6. Code reviewed (linting, formatting)
7. No regressions

---

## Common Mistakes

| Wrong | Right |
|---------|---------|
| Edit .md files directly | Use \`knowns task edit\` |
| Change \`- [ ]\` to \`- [x]\` in file | Use \`--check-ac <index>\` |
| Start coding without reading docs | Read docs FIRST, then plan |
| Plan without checking docs | Search and read docs before planning |
| Missing doc links in description/plan | Link docs using \`[file.md](./path/file.md)\` |
| Forget to use \`--plain\` flag | Always use \`--plain\` for AI |
| Forget to share plan before coding | Share plan, WAIT for approval |
| Mark done without all criteria checked | Check ALL criteria first |
| Write implementation details in AC | Write outcome-oriented criteria |
| Use \`"In Progress"\` or \`"Done"\` | Use \`in-progress\`, \`done\` |

---

## Best Practices

### Critical Rules
- **ALWAYS use \`--plain\` flag** for AI-readable output
- **Read documentation BEFORE planning**: \`knowns search "keyword" --type doc --plain\`
- **Link docs in tasks**: Use \`[file.md](./path/file.md)\` or \`[mapper.md](./patterns/mapper.md)\`
- **Share plan before coding**: Get approval first
- **Start time tracking**: \`knowns time start <id>\` before work
- **Stop time tracking**: \`knowns time stop\` after work
- **Check criteria as you go**: Don't wait until end
- **Add notes progressively**: Use \`--append-notes\`

### Multi-line Input
- **Bash/Zsh**: \`$'Line1\\nLine2\\nLine3'\`
- **PowerShell**: \`"Line1\\\`nLine2\\\`nLine3"\`
- **Portable**: \`"$(printf 'Line1\\nLine2\\nLine3')"\`

### Documentation Workflow
1. Search: \`knowns search "keyword" --type doc --plain\`
2. Read: \`knowns doc view "Doc Name" --plain\`
3. Link in description: \`[file.md](./path/file.md)\`
4. Link in plan: Reference specific sections
5. Update after implementation

---

## Status & Priority Values

**Status** (lowercase with hyphens):
- \`todo\` - Not started
- \`in-progress\` - Currently working
- \`in-review\` - In code review
- \`done\` - Completed
- \`blocked\` - Waiting on dependency

**Priority**:
- \`low\` - Can wait
- \`medium\` - Normal (default)
- \`high\` - Urgent, important

---

## Quick Reference

\`\`\`bash
# Full workflow
knowns task create "Title" -d "Description" --ac "Criterion"
knowns task edit <id> -s in-progress -a @yourself
knowns time start <id>
knowns search "keyword" --type doc --plain
knowns doc view "Doc Name" --plain
knowns task edit <id> --plan $'1. Step (see [file.md](./file.md))\\n2. Step'
# ... implement code ...
knowns task edit <id> --check-ac 1 --check-ac 2
knowns task edit <id> --append-notes "✓ Completed"
knowns time stop
knowns task edit <id> -s done

# View task
knowns task view <id> --plain

# List tasks
knowns task list --plain
knowns task list --status in-progress --assignee @yourself --plain

# Search
knowns search "query" --plain
knowns search "bug" --type task --status in-progress --plain
\`\`\`

---

**Last Updated**: 2025-12-26
**Version**: 2.1.0
**Maintained By**: Knowns CLI Team

<!-- KNOWNS GUIDELINES END -->
`;
