---
title: SDD Fulfills Mapping Pattern
createdAt: '2026-02-24T08:26:47.625Z'
updatedAt: '2026-02-24T08:26:47.625Z'
description: Pattern for linking tasks to spec acceptance criteria using the fulfills field
tags:
  - pattern
  - sdd
  - task
  - spec
  - fulfills
---
# SDD Fulfills Mapping Pattern

> Pattern for linking tasks to spec acceptance criteria and auto-syncing completion status.

## Overview

The `fulfills` field creates an explicit mapping between **Tasks** and **Spec ACs**. When a task is marked done, the system automatically checks the corresponding ACs in the spec document.

```
Task (fulfills: ["AC-1", "AC-2"]) → done → Spec ACs auto-checked
```

## Key Concepts

### Task ACs vs Spec ACs

| Type | Purpose | Example |
|------|---------|---------|
| **Spec ACs** | High-level feature outcomes | "AC-1: Users can search docs by content" |
| **Task ACs** | Implementation steps | "Add search endpoint", "Write tests" |

A single task may fulfill multiple Spec ACs, and multiple tasks may contribute to the same Spec AC.

### Data Model

```typescript
// Task model
interface Task {
  spec?: string;           // "specs/semantic-search"
  fulfills?: string[];     // ["AC-1", "AC-2"]
  acceptanceCriteria: AC[]; // Task-level implementation steps
}
```

### Spec Document Format

```markdown
## Requirements

### REQ-1: Search Feature

**Acceptance Criteria:**
- [ ] AC-1: Users can search documents by content
- [ ] AC-2: Search results show relevance score
- [x] AC-3: Search supports filters (fulfilled by task-xyz)
```

## Implementation

### 1. Task Creation with Fulfills

```bash
# CLI
knowns task create "Implement search API" \
  --spec specs/semantic-search \
  --fulfills AC-1,AC-2

# MCP
mcp__knowns__create_task({
  "title": "Implement search API",
  "spec": "specs/semantic-search",
  "fulfills": ["AC-1", "AC-2"]
})
```

### 2. Auto-Sync Logic

When task status changes to "done" or `fulfills` is updated:

```typescript
// src/utils/sync-spec-acs.ts
export async function syncSpecACs(task: Task, projectRoot: string) {
  if (!task.spec || !task.fulfills?.length) return { synced: false };
  
  // Read spec content
  const specPath = resolveSpecPath(task.spec, projectRoot);
  let content = await fs.readFile(specPath, 'utf-8');
  
  // Update each fulfilled AC
  for (const acId of task.fulfills) {
    // Match: - [ ] AC-1: description
    const regex = new RegExp(`- \\[ \\] (${acId}:)`, 'g');
    content = content.replace(regex, `- [x] $1`);
  }
  
  await fs.writeFile(specPath, content);
  return { synced: true };
}
```

### 3. Trigger Points

Sync should be triggered when:
- Task status → "done"
- `fulfills` field is updated
- Task ACs are modified (with fulfills present)

```typescript
// In task update handler
const fulfillsUpdated = input.fulfills !== undefined;
if (acModified || fulfillsUpdated || input.status === "done") {
  await syncSpecACs(task, projectRoot);
}
```

### 4. Validation Integration

The `validate --sdd` command shows fulfills coverage:

```
specs/semantic-search (8 ACs):
  AC-1: ✓ fulfilled by task-abc
  AC-2: ✓ fulfilled by task-abc
  AC-3: ○ not fulfilled
  
Coverage: 2/8 (25%)
```

## Usage Patterns

### Creating Tasks from Spec

When using `/kn-plan --from @doc/specs/feature`:

1. Parse spec ACs (AC-1, AC-2, etc.)
2. Group related ACs into logical tasks
3. Set `fulfills` to link task → ACs
4. Add implementation ACs for task-level work

```json
mcp__knowns__create_task({
  "title": "Implement embedding generation",
  "spec": "specs/semantic-search",
  "fulfills": ["AC-1", "AC-2"],
  "labels": ["from-spec"]
})

mcp__knowns__update_task({
  "taskId": "new-id",
  "addAc": ["Create embedding service", "Add API endpoint", "Write tests"]
})
```

### Verifying Completion

Before marking spec as complete:

```bash
knowns validate --sdd
```

Shows which Spec ACs are still unfulfilled.

## Best Practices

1. **Map early**: Add `fulfills` when creating tasks from specs
2. **Granular mapping**: One task can fulfill multiple ACs, but keep it focused
3. **Validate often**: Run `validate --sdd` to track coverage
4. **Don't duplicate**: Spec ACs are outcomes, task ACs are steps

## Source

> Implemented in @task-d5l46c: Add `fulfills` field to link Task → Spec ACs
