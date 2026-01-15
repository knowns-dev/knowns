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
