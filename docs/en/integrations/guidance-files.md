# Guidance Files

Knowns uses one canonical file plus several compatibility files for AI runtimes.

## Canonical file

- `KNOWNS.md`

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
knowns setup
knowns sync
knowns sync --instructions
```

Use `knowns init` to create initial project guidance files. Use `knowns setup agents` to create or refresh only `KNOWNS.md` + `AGENTS.md`, `knowns setup <target>` for full platform integrations, or `knowns sync` to refresh generated files from config.
