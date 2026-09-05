# Memory System

Memory is where Knowns stores durable context that should be recalled later.

## The three layers

- **working memory**: short-lived, session-scoped context
- **project memory**: patterns, conventions, failures, and short implementation context specific to one repository
- **global memory**: user-level preferences or reusable rules across projects

## When to use memory instead of docs

Use memory when the information is:

- short enough to recall quickly
- useful for recall but not a durable system-level choice
- useful across many future interactions

Use docs when the information needs longer narrative explanation or structured sections.

## Typical examples

- “We use repository pattern for data access”
- “Always validate before marking a task done”
- “This team prefers semantic search before manual grep for exploratory work”

## Commands

```bash
knowns memory create "We use repository pattern" --category pattern
knowns memory list --plain
knowns memory <id> --plain
```

Memory category `decision` is legacy and new writes are rejected. Existing entries remain readable until a reviewed migration has a verified, accepted, current replacement and Decision consumption is active. Record durable architecture or workflow choices with a first-class System Decision instead:

```bash
knowns decision create "Use Postgres for metadata"
knowns decision link <id> --source @doc/architecture/storage --task <done-task-id>
knowns decision accept <id>
```

Use `knowns decision migrate preview --plain` for a read-only inventory. Apply only one explicitly reviewed resolution at a time; use `knowns decision migrate rollback <memory-id>` to reverse a safe migration.

## Related

- [Task Management](./task-management.md)
- [Reference System](../reference/reference-system.md)
