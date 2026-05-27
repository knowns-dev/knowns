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
knowns setup
knowns sync
knowns sync --instructions
```

Use `knowns setup` to generate platform files initially, or `knowns sync` to refresh them.
