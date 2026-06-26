# User Guide

This guide is for people using Knowns in an actual project, not just trying the CLI once.

Knowns is most useful when you treat it as the shared project context beside your source code. The CLI, MCP server, and Web UI all read and update the same project state, so work created in one surface is visible in the others.

## Core model

Knowns works best when you think of it as a project context layer with five connected parts:

- **tasks** for planned work, status, acceptance criteria, implementation plans, and notes
- **docs** for durable project knowledge such as architecture, specs, decisions, and onboarding
- **memory** for short reusable context such as team conventions or assistant preferences
- **templates** for repeated project scaffolding
- **search / retrieval** for finding the relevant context when people or AI need it

The important habit is to put reusable context into Knowns instead of leaving it only in chat messages.

## What you will see during `knowns init`

- an interactive wizard
- post-wizard steps such as:
  - project structure creation
  - settings application
  - git integration configuration
  - lightweight project instruction shim creation, such as `CLAUDE.md` and `AGENTS.md`
  - semantic index building (if enabled)

After init, run `knowns setup <target> --global` to configure user-level AI platform integrations such as skills, MCP configs, and runtime hooks. This is the recommended setup for personal assistant usage across repositories. Use `knowns setup <target>` only when you intentionally want repo-local integration files, or `knowns setup agents` if you only need lightweight repo-local shims such as `AGENTS.md`.

## Common first-week workflow

1. Create one task for the next real change.
2. Add acceptance criteria that make success observable.
3. Create or update a doc for architecture or product context the task depends on.
4. Use `knowns search` or `knowns retrieve` to confirm the context can be found.
5. Let your AI assistant read the task, docs, and memory through MCP or lightweight shim files.
6. Validate before marking the work done.

You do not need to document everything on day one. Start with the work that is active, then add docs and memory when repeated explanations become obvious.

## Terminal behavior

- the wizard uses an alternate screen to reduce redraw glitches during resize
- third-party installer output can still be noisy

## Daily usage patterns

### Create and update tasks

```bash
knowns task create "Add authentication" -d "JWT-based auth"
knowns task edit <id> -s in-progress
knowns task edit <id> --check-ac 1
knowns task edit <id> --append-notes "Completed auth middleware"
```

### Create and read docs

```bash
knowns doc create "Auth Architecture" -d "Design overview" -f architecture
knowns doc "architecture/auth-architecture" --plain
knowns doc "architecture/auth-architecture" --toc --plain
```

### Search for context

```bash
knowns search "authentication" --plain
knowns retrieve "how auth works" --json
```

### Validate before finishing work

```bash
knowns validate --plain
```

### Keep generated artifacts aligned

```bash
knowns sync
```

## Choosing a surface

- Use the CLI when you want fast commands, scripts, or terminal-first work.
- Use the Web UI when you want a board, doc browser, graph view, config pages, or chat workflow.
- Use MCP when an AI assistant needs structured access to tasks, docs, search, memory, templates, and validation.
- Use skills when you want agent-side workflows such as spec creation, implementation, review, or full flow orchestration.

## Recommended next reads

- [Workflow](./workflow.md)
- [MCP integration](./mcp-integration.md)
- [Commands](../reference/commands.md)
