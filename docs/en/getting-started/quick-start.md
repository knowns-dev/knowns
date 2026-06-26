# Quick Start

This is the fastest path to a working Knowns project. By the end, your repository will have Knowns project state, one task, one doc, working validation, and a Web UI you can open again later.

Run these commands from the repository you want Knowns to manage.

## 1. Initialize the project

```bash
knowns init
# or, without a global install:
npx knowns init
```

The init flow configures:

- project name
- git tracking mode (with per-section toggles)
- lightweight project instruction shims such as `CLAUDE.md` and `AGENTS.md`
- semantic search
- embedding model

`knowns init` creates the local Knowns project store and lightweight compatibility shims. Runtime-critical AI guidance comes from MCP `initial` and on-demand `help`, so those files should stay small. AI platform integrations such as MCP configs, skills, and runtime hooks are configured separately with `knowns setup <target> --global` for user-level setup, or `knowns setup <target>` when you intentionally want repo-local integration files.

## 2. Create a task

```bash
knowns task create "Setup project" -d "Initialize project with Knowns"
```

Tasks are the main unit of planned work. They give both people and AI assistants a concrete target.

## 3. Create a document

```bash
knowns doc create "Architecture" -d "System overview" -f architecture
```

Docs hold durable project knowledge. They are better than repeating the same context in every AI chat.

## 4. Check the project

```bash
knowns search "architecture" --plain
knowns validate --plain
```

Search confirms retrieval can find project context. Validate checks the Knowns project structure before you build more workflow on top of it.

## 5. Open the Web UI

```bash
knowns browser --open
```

The Web UI shows the same project state as the CLI, including tasks, docs, graph views, config, and chat workflows.

## 6. Optional: connect your AI platform

Use setup for the platform you actually use:

```bash
knowns setup codex --global
knowns setup claude --global
knowns setup agents
```

Use `--global` for your normal personal assistant setup so Knowns updates user-level MCP config, skills, and runtime hooks across repositories. Use `knowns setup agents` when you only need repo-local compatibility shims such as `AGENTS.md`.

After setup, agent workflows can use the lightweight shim files, MCP config, and skills for that platform. Claude uses `/kn-*` skill commands; Codex uses `$kn-*` skill commands.

See [Platforms](../integrations/platforms.md) for supported setup targets.

## 7. Sync generated artifacts when needed

```bash
knowns sync
knowns update
```

Use `knowns sync` after cloning, after changing selected platforms, or after updating the CLI. Use `knowns update` when you want Knowns to refresh generated project artifacts to the current CLI behavior.

## 8. Open the Web UI again later

```bash
knowns browser --open
```

## What you have now

- a Knowns project initialized in this repository
- lightweight compatibility shims for agents
- one task and one doc to prove the project model works
- a way to search, validate, and browse project context

## Related

- [First project](./first-project.md)
- [User guide](../guides/user-guide.md)
- [Workflow](../guides/workflow.md)
