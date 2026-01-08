---
title: Knowns CLI - ID Strategy
createdAt: '2026-01-08T08:48:57.016Z'
updatedAt: '2026-01-08T08:53:21.152Z'
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

References work for both `@task-1` and `@task-a7f3k9`. No migration required.

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
Tasks: @task-a7f3k9
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
