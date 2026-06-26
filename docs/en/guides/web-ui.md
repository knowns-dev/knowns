# Web UI

Knowns includes a browser UI for people who prefer to inspect project context visually instead of only through CLI output. It reads the same project state as the CLI and MCP server, so tasks, docs, memory, graph views, config, and chat workflows stay connected.

## Open it

```bash
knowns browser
knowns browser --open
```

Run the command from a Knowns project. Use `--open` when you want Knowns to start the local server and open your default browser automatically.

## Main areas

- **Board and task views**: scan active work, status, priorities, acceptance criteria, and notes.
- **Docs browser**: read project docs without remembering CLI paths.
- **Graph / knowledge views**: explore relationships between tasks, docs, memory, and references.
- **Configuration pages**: inspect project settings, search setup, code intelligence, and integration state.
- **Chat page**: use chat-driven workflows when the browser UI is a better fit than a terminal.

## When to use it

- when you want a board-oriented task view
- when browsing docs is easier in a UI than in CLI output
- when you want graph exploration or chat-driven workflows
- when onboarding someone who should understand the project before using CLI commands

## How it fits with AI setup

The Web UI is not a replacement for MCP `initial` and `help`. It is the human-facing view of the same context. AI assistants should still start from MCP `initial`, use `help` for workflow/tool details, and use the Web UI only when a person wants to inspect or edit context visually.
