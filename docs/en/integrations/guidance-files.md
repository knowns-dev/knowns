# Guidance Files

Knowns uses lightweight compatibility files for AI runtimes that auto-detect repository instruction files. These files should be small entrypoints that tell the assistant to start with Knowns MCP `initial` and use on-demand `help` for tool schemas and workflow guidance.

Runtime-critical guidance lives in MCP `initial` and `help`, not in a large repository prompt file. This lets Knowns update agent behavior without requiring every repository to change generated markdown.

## Compatibility files

- `CLAUDE.md`
- `OPENCODE.md`
- `GEMINI.md`
- `AGENTS.md`
- `.github/copilot-instructions.md`

## Refresh generated content

```bash
knowns init
knowns setup agents
knowns setup --global
knowns sync
knowns sync --instructions
```

Use `knowns init` to create the initial project state and selected lightweight shims. Use `knowns setup agents` to create or refresh generic repo-local shims, `knowns setup <target> --global` for normal personal platform integrations, or `knowns sync` to refresh generated files from config.

## Agent bootstrap

At session start, the assistant should:

1. call MCP `initial`
2. use `help("tool.*")` or `help("workflow.*")` when it needs details
3. use CLI commands only as a fallback when MCP is unavailable
