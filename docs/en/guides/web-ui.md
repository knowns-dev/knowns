# Web UI

Knowns includes a browser UI for people who prefer to inspect project context visually instead of only through CLI output. It reads the same project state as the CLI and MCP server, so tasks, docs, memory, graph views, and config stay connected.

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

## Workspaces and auto-scan

The Web UI can hold several Knowns projects at once. The workspace switcher lists every project Knowns knows about, and the list lives in `~/.knowns/registry.json`.

Projects reach that list two ways:

- running `knowns browser` inside a project registers that project
- auto-scan, which runs when the Welcome page loads and each time the workspace switcher opens

Auto-scan looks one level deep inside your home directory and the common project folders below it, and registers every subdirectory that contains an initialized `.knowns/`:

`~`, `~/Projects`, `~/Developer`, `~/Documents`, `~/Code`, `~/repos`, `~/workspace`, `~/src`, `~/go/src`, and `~/dev`.

Each of those is checked in both capitalizations, since either can be the real one. There is currently no setting that turns auto-scan off.

Registry entries are stored under the spelling the folder actually has on disk. That matters on Windows and on the default macOS filesystem, where `~/Projects/app` and `~/projects/app` name one directory: both resolve to a single workspace instead of two. Registries written by earlier versions that already contain the same folder twice collapse to one entry the next time they are read. On a case-sensitive filesystem two directories that differ only in capitalization are genuinely different folders, and stay two separate workspaces.

## When to use it

- when you want a board-oriented task view
- when browsing docs is easier in a UI than in CLI output
- when you want graph exploration
- when onboarding someone who should understand the project before using CLI commands

## How it fits with AI setup

The Web UI is not a replacement for MCP `initial` and `help`. It is the human-facing view of the same context. AI assistants should still start from MCP `initial`, use `help` for workflow/tool details, and use the Web UI only when a person wants to inspect or edit context visually.
