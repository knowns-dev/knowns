<!-- KNOWNS GUIDELINES START -->
# Knowns CLI Guidelines

## Core Principle

**NEVER edit .md files directly. ALL operations MUST use CLI commands.**

---

## Project Structure

```
.knowns/
├── tasks/              # Task files: task-<id> - <title>.md
├── docs/               # Documentation (supports nested folders)
└── decisions/          # Architecture decision records
```

---

## Task Management

### Task Lifecycle

1. **Create** → `knowns task create "Title" -d "Description" --ac "Criterion 1" --ac "Criterion 2"`
2. **Start** → `knowns task edit <id> -s "In Progress" -a @yourself`
3. **Work** → Check acceptance criteria as you complete them
4. **Complete** → Mark status as Done after all criteria met

### Critical Commands

```bash
# View task (always use --plain for AI)
knowns task view <id> --plain

# List tasks
knowns task list --plain
knowns task list -s "In Progress" --plain

# Search tasks/docs
knowns search "query" --plain
knowns search "query" --type task --plain

# Edit task
knowns task edit <id> -s "In Progress" -a @agent
knowns task edit <id> -t "New Title"
knowns task edit <id> -d "Description"

# Acceptance criteria
knowns task edit <id> --ac "New criterion"
knowns task edit <id> --check-ac 1
knowns task edit <id> --check-ac 1 --check-ac 2 --check-ac 3
knowns task edit <id> --uncheck-ac 2
knowns task edit <id> --remove-ac 3

# Implementation
knowns task edit <id> --plan $'1. Step one\n2. Step two'
knowns task edit <id> --notes "Implementation summary"
knowns task edit <id> --append-notes $'Additional note\nAnother line'
```

### Multi-line Input (Shell-specific)

**Bash/Zsh** - Use `$'...\n...'`:
```bash
knowns task edit 42 --desc $'Line 1\nLine 2\n\nLine 3'
knowns task edit 42 --plan $'1. First\n2. Second'
knowns task edit 42 --notes $'Done A\nDoing B'
```

**PowerShell** - Use backtick-n:
```powershell
knowns task edit 42 --notes "Line1`nLine2"
```

**Portable** - Use printf:
```bash
knowns task edit 42 --notes "$(printf 'Line1\nLine2')"
```

---

## Task Workflow

### Step 1: Take Task
```bash
knowns task edit <id> -s "In Progress" -a @yourself
```

### Step 2: Create Plan
```bash
knowns task edit <id> --plan $'1. Research\n2. Implement\n3. Test'
```

**IMPORTANT**: Share plan with user and wait for approval before coding.

### Step 3: Implementation
Write code, then check acceptance criteria:
```bash
knowns task edit <id> --check-ac 1 --check-ac 2 --check-ac 3
```

### Step 4: Add Notes (PR Description)
```bash
knowns task edit <id> --notes $'Implemented using X pattern\nUpdated tests\nReady for review'
```

Or append progressively:
```bash
knowns task edit <id> --append-notes "Completed feature X"
knowns task edit <id> --append-notes "Added tests"
```

### Step 5: Complete
```bash
knowns task edit <id> -s Done
```

---

## Definition of Done

Task is Done ONLY when ALL items are complete:

**Via CLI:**
1. All acceptance criteria checked: `--check-ac <index>`
2. Implementation notes added: `--notes "..."`
3. Status set to Done: `-s Done`

**Via Code:**
4. Tests pass
5. Documentation updated
6. Code reviewed
7. No regressions

---

## Documentation Management

### Commands

```bash
# List all docs (includes nested folders)
knowns doc list --plain

# View document
knowns doc view <name> --plain
knowns doc view patterns/guards --plain
knowns doc view patterns/guards.md --plain

# Create document
knowns doc create "Title" -d "Description" -t "tag1,tag2"

# Edit metadata
knowns doc edit <name> -t "New Title" -d "New Description"
```

### Document Links

In `--plain` mode, markdown links are replaced with resolved paths:
- `[guards.md](./patterns/guards.md)` → `@.knowns/docs/patterns/guards.md`

---

## Task Structure

### Title
Brief, clear summary of the task.

### Description
Explains WHY and WHAT (not HOW). Provides context.

### Acceptance Criteria
**Outcome-oriented**, testable, user-focused criteria.

Good:
- "User can login with valid credentials"
- "System processes 1000 requests/sec without errors"

Bad:
- "Add function handleLogin() in auth.ts" (implementation detail)

### Implementation Plan (added during work)
**HOW** to solve the task. Added AFTER taking the task, BEFORE coding.

### Implementation Notes (PR description)
Summary of what was done, suitable for PR. Added AFTER completion.

---

## Common Mistakes

| Wrong | Right |
|-------|-------|
| Edit .md files directly | Use `knowns task edit` |
| Change `- [ ]` to `- [x]` in file | Use `--check-ac <index>` |
| Add plan during creation | Add plan when starting work |
| Mark Done without all criteria | Check ALL criteria first |

---

## Search

```bash
# Search everything
knowns search "auth" --plain

# Search tasks only
knowns search "login" --type task --plain

# Search with filters
knowns search "api" --status "In Progress" --plain
knowns search "bug" --priority high --plain
```

---

## Required Patterns

### When Starting Task
```bash
# Step 1: Assign and set in progress
knowns task edit <id> -s "In Progress" -a @yourself

# Step 2: Add implementation plan
knowns task edit <id> --plan $'1. Research codebase\n2. Implement\n3. Test'

# Step 3: Share plan with user, WAIT for approval
# Step 4: Start coding only after approval
```

### When Completing Task
```bash
# Step 1: Check all acceptance criteria
knowns task edit <id> --check-ac 1 --check-ac 2 --check-ac 3

# Step 2: Add implementation notes (PR description)
knowns task edit <id> --notes $'Summary of changes\nTesting approach\nFollow-up needed'

# Step 3: Mark as done
knowns task edit <id> -s Done
```

### Only Implement What's In Acceptance Criteria
If you need to do more:
1. Update AC first: `knowns task edit <id> --ac "New requirement"`
2. Or create new task: `knowns task create "Additional feature"`

---

## Tips

- Always use `--plain` flag for AI-readable output
- AC flags accept multiple values: `--check-ac 1 --check-ac 2`
- Mixed operations work: `--check-ac 1 --uncheck-ac 2 --remove-ac 3`
- Use `$'...\n...'` for multi-line input in Bash/Zsh
- Related docs show as `@.knowns/docs/path/to/file.md` in plain mode

---

## Full Help

```bash
knowns --help
knowns task --help
knowns doc --help
knowns search --help
```
<!-- KNOWNS GUIDELINES END -->

