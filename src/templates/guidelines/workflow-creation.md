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
