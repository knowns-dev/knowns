# Core Rules (MCP)

You MUST follow these rules. If you cannot follow any rule, stop and ask for guidance before proceeding.

---

## The Golden Rule

**If you want to change ANYTHING in a task or doc, use MCP tools. NEVER edit .md files directly.**

Why? Direct file editing breaks metadata synchronization, Git tracking, and relationships.

---

## Core Principles

| Rule | Description |
|------|-------------|
| **MCP Tools Only** | Use MCP tools for ALL operations. NEVER edit .md files directly |
| **Docs First** | Read project docs BEFORE planning or coding |
| **Time Tracking** | Always start timer when taking task, stop when done |
| **Plan Approval** | Share plan with user, WAIT for approval before coding |
| **Check AC After Work** | Only mark acceptance criteria done AFTER completing the work |

---

## Reference System

| Type | Format | Example |
|------|--------|---------|
| **Task ref** | `@task-<id>` | `@task-pdyd2e` |
| **Doc ref** | `@doc/<path>` | `@doc/patterns/auth` |

Follow refs recursively until complete context gathered.

---

## Task IDs

| Format | Example | Notes |
|--------|---------|-------|
| Sequential | `48`, `49` | Legacy numeric |
| Hierarchical | `48.1`, `48.2` | Legacy subtasks |
| Random | `qkh5ne` | Current (6-char) |

**CRITICAL:** Use raw ID (string) for all MCP tool calls.

---

## Status & Priority

| Status | When |
|--------|------|
| `todo` | Not started (default) |
| `in-progress` | Currently working |
| `in-review` | PR submitted |
| `blocked` | Waiting on dependency |
| `done` | All criteria met |

| Priority | Level |
|----------|-------|
| `low` | Nice-to-have |
| `medium` | Normal (default) |
| `high` | Urgent |
