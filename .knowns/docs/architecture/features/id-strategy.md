---
title: Knowns CLI - ID Strategy
createdAt: '2026-01-08T08:48:57.016Z'
updatedAt: '2026-01-09T07:46:23.699Z'
description: ID generation and collision handling for Knowns CLI entities
tags:
  - cli
  - id
---
# Knowns CLI - ID Strategy

> How IDs are generated and managed in Knowns CLI

---

## 1. ID Format

```
Tasks: task-{random_6_chars}

Docs:  path-based (folder/path/title)
Plans: path-based (folder/path/title)
Repo Tasks: path/slug-based

Task charset: a-z + 0-9 = 36 characters
Task length:  6 characters
Total task combos: 36^6 = 2,176,782,336 (~2.1 billion)
```

### Examples

```bash
$ knowns task add "Fix login bug"
Created task-a7f3k9

$ knowns doc add "API Specification" -f api
Created docs/api/api-specification.md  # path-based
```

---

## 2. Why 6 Characters for Tasks?

| Length | Total IDs | Safe Limit (<1% collision) | 50% collision at |
|--------|-----------|----------------------------|------------------|
| 4 chars | 1.6M | ~180 items | ~1,500 items |
| **6 chars** | **2.1B** | **~6,600 items** | **~55,000 items** |
| 8 chars | 2.8T | ~237,000 items | ~2,000,000 items |

6 characters hit the sweet spot for tasks:
- Short enough to remember and type
- Long enough to avoid collisions
- Safe for ~6,600 tasks per project

Docs/plans/repo tasks remain path-based; no change needed there.

---

## 3. Core Principle for Tasks: Local ID = Global ID

The task local ID is the unique identifier; no separate UID is needed.

Alice's machine and Bob's machine both store the same task IDs:
- task-a7f3k9
- task-m2x8p4

Same ID everywhere = same task. References stay consistent across machines.

---

## 4. Backward Compatibility (Tasks)

Old sequential task IDs (`task-1`, `task-2`) continue to work alongside new random task IDs.

Existing task files stay valid:
- task-1.md
- task-2.md
- task-123.md

New task files use random IDs:
- task-a7f3k9.md
- task-m2x8p4.md
- task-k9y2z7.md

References work for both `[removed [removed [removed @task-1]]]` and `[removed [removed [removed @task-a7f3k9]]]`. No migration required.

Docs/plans/repo tasks keep their path/slug-based identifiers untouched.

---

## 5. Collision Handling (Tasks)

- On task creation, the CLI checks if the generated ID already exists
- If a collision is detected, retry with a new random ID
- Maximum 10 retries
- Collision probability: ~0.0015% at 6,600 tasks

---

## 6. Reference System

Use `@` prefix to reference items:

```markdown
Tasks: [removed [removed [removed @task-a7f3k9]]]
Docs:  @doc/api/spec
Plans: @doc/planning/q1-roadmap  # path-based
```

References work consistently across all machines.

---

## 7. Summary

| Aspect | Value |
|--------|-------|
| Task format | `task-{6_chars}` |
| Task charset | a-z, 0-9 (36 chars) |
| Task combinations | ~2.1 billion |
| Task safe limit | ~6,600 tasks/project |
| Task backward compatibility | Yes (`task-1` still works) |
| Docs/plans/repo tasks | Path/slug-based (unchanged) |
| Migration needed | No |

---

Document version: 1.1



---

## 8. Subtask IDs

### Subtask ID Generation

When creating a subtask with `--parent`, the subtask receives a **random 6-character ID** (same format as regular tasks), NOT a hierarchical ID.

```bash
# Example: Creating subtask of task 48
$ knowns task create "My Subtask" --parent 48
✓ Created task-qkh5ne: My Subtask
  Subtask of: 48
```

### Hierarchical IDs (Legacy)

Some existing tasks have hierarchical IDs like `48.1`, `48.2`. These were created through:
- Direct file creation
- Import from other systems
- Legacy versions of the CLI

The current CLI does NOT automatically generate hierarchical IDs. All new subtasks get random IDs.

### ID Types in Knowns

| Type | Format | Example | Source |
|------|--------|---------|--------|
| Sequential | Numeric | `48`, `49`, `50` | Legacy tasks |
| Hierarchical | Parent.N | `48.1`, `48.2` | Legacy subtasks |
| Random | 6-char base36 | `qkh5ne`, `a7f3k9` | Current CLI |

### Using `--parent` Flag

The `--parent` flag accepts the **raw task ID** (not prefixed):

```bash
# ✅ Correct - use raw ID
knowns task create "Subtask Title" --parent 48
knowns task create "Subtask Title" --parent qkh5ne

# ❌ Wrong - do NOT prefix with "task-"
knowns task create "Subtask Title" --parent task-48    # ERROR
knowns task create "Subtask Title" --parent task-qkh5ne  # ERROR
```

### Verifying Parent Task Exists

Before using `--parent`, verify the task ID:

```bash
# Check if parent task exists
$ knowns task 48 --plain
# OR
$ knowns task qkh5ne --plain

# If you get "Task not found", the ID is wrong
```

### Task List Output Format

When using `knowns task list --plain`, the output shows:

```
[PRIORITY] <id> - <title>
```

Example:
```
[HIGH] 48 - Hub Integration: CLI Commands
[HIGH] qkh5ne - My Subtask
```

The ID is the first value after `[PRIORITY]`. Use this ID directly with `--parent`.

---

Document version: 1.2
