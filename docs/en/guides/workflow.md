# Workflow

This is the recommended human + AI workflow with Knowns.

The goal is to keep planning, context, implementation notes, and validation visible outside a single chat session. A person can drive the workflow from the CLI or Web UI; an AI assistant can use the same context through MCP tools and skills.

## Suggested loop for any project

1. run `knowns init` once per project
2. create tasks and supporting docs
3. let AI start with MCP `initial`, then use `help`, tasks, docs, and memory as needed
4. implement changes
5. validate
6. sync or update generated artifacts when needed

This loop works even without an AI assistant. The AI integration simply makes the same project state available to the assistant.

## Typical command loop

```bash
knowns task create "..."
knowns doc create "..."
knowns search "..." --plain
knowns retrieve "..." --json
knowns validate --plain
knowns sync
```

## Human-driven workflow

Use this when you want Knowns as a project organization layer:

1. Create a task with acceptance criteria.
2. Add docs for architecture, decisions, or onboarding context.
3. Search before starting work so you know what context already exists.
4. Update task notes as work progresses.
5. Run validation before marking the task done.

## AI-assisted workflow

Use this when an assistant is helping with planning or implementation:

1. Run `knowns setup <target> --global` for the assistant platform.
2. Ask the assistant to inspect project state first.
3. Have the assistant work from a task, doc, or spec instead of from a vague prompt.
4. Use MCP tools for structured reads/writes when available.
5. Use skills for agent-side workflows such as spec, implementation, review, verification, or flow orchestration.

`--global` is recommended for personal assistant setup because it updates user-level MCP config, skills, and runtime hooks. Use non-global setup only when you intentionally want repo-local integration files. Skill command prefixes depend on the assistant surface. Claude uses `/kn-*`; Codex uses `$kn-*`.

## Why this works well

- tasks define execution targets
- docs explain structure and intent
- memory preserves decisions and conventions
- retrieval connects everything for humans and AI

## When to use which surface

- **CLI**: quick authoring, scripting, CI-friendly validation, and direct project maintenance
- **MCP**: structured AI integration for tasks, docs, memory, search, templates, code navigation, and validation
- **Web UI**: board, docs, graph, config, and chat workflows
- **Skills**: assistant-side workflow commands, for example spec creation, review, or `kn-flow` orchestration

## Finishing work

Before calling work complete:

```bash
knowns validate --plain
knowns sync
```

Validation checks project integrity. Sync keeps generated shim files and platform artifacts aligned with the current Knowns config.
