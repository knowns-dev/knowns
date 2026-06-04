# User Guide

This guide is for people using Knowns in an actual project, not just trying the CLI once.

## Core model

Knowns works best when you think of it as a project context layer with five connected parts:

- tasks
- docs
- memory
- templates
- search / retrieval

The CLI, MCP server, and browser UI all operate on the same project state.

## What you will see during `knowns init`

- an interactive wizard
- post-wizard steps such as:
  - project structure creation
  - settings application
  - git integration configuration
  - project instruction file creation (`KNOWNS.md`, default `CLAUDE.md` + `AGENTS.md`)
  - semantic index building (if enabled)

After init, run `knowns setup <target>` to configure AI platform integrations such as skills, MCP configs, and runtime hooks. Use `knowns setup agents` if you only need `KNOWNS.md` + `AGENTS.md`.

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

## Recommended next reads

- [Workflow](./workflow.md)
- [MCP integration](./mcp-integration.md)
- [Commands](../reference/commands.md)
