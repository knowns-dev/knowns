# AI Agent Guide

This guide explains how to use Knowns effectively with AI assistants.

## Core idea

AI works better when it does not have to guess project context.

Knowns gives AI a structured way to access:

- tasks
- docs
- memory
- references
- validation
- search and retrieval

## Recommended usage pattern

### 1. Call `initial` first

The AI should call the `initial` MCP tool at session start. It returns project state, code intelligence rules, workflow guidance, and available tools — everything needed to begin work.

### 2. Use `help` for tool details

When the AI needs to use an unfamiliar tool or action, call `help("tool.action")` or `help("tool.*")` for on-demand documentation.

### 3. Use tasks as execution targets

Instead of giving a vague prompt, point the AI at a task with acceptance criteria.

### 3. Use docs for durable explanation

Architecture, patterns, and operational guidance should live in docs rather than only in chat.

### 4. Use memory for durable decisions

Store reusable decisions, conventions, and failures in memory so they can be recalled later.

### 5. Validate before calling work complete

Validation should be part of the normal workflow.

## Research source order

When an AI needs to understand a codebase or upstream behavior, it should search in this order:

1. Knowns `search` and `retrieve` for local project context.
2. Knowns `code` tools for code structure, symbols, definitions, references, diagnostics, and edits.
3. External MCP providers such as Context7/library docs, GitHub/source MCP, or official docs MCP when current upstream facts matter.
4. General web search when specialized MCP providers are unavailable, insufficient, or explicitly requested.

External research should be cited and reconciled with local source-of-truth files instead of overriding them silently.

## MCP vs CLI

### Prefer MCP when:

- the AI runtime supports it
- you want structured tool calls
- you want less shell parsing and less prompt copy-paste

### Prefer CLI when:

- MCP is unavailable
- you are scripting outside an MCP-aware runtime
- you want to inspect output manually in a terminal

## Example workflow

1. AI calls `initial` (gets project state + rules + workflow guidance)
2. AI reads the target task
3. AI follows any `@doc/...` or `@task-...` references
4. AI calls `help("tool.action")` if unsure how to use a tool
5. AI uses `code` tools for code discovery and editing (not Read/Grep/Edit)
6. AI implements changes
7. AI runs validation or tests

## Related

- [Task Management](./task-management.md)
- [MCP Integration](./mcp-integration.md)
- [Workflow](./workflow.md)
