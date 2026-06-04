# Guidance files

Knowns dùng một file canonical và nhiều compatibility files cho các AI runtimes.

## Canonical

- `KNOWNS.md`

## Compatibility files

- `CLAUDE.md`
- `OPENCODE.md`
- `GEMINI.md`
- `AGENTS.md`
- `.github/copilot-instructions.md`

## Refresh

```bash
knowns init
knowns setup agents
knowns setup
knowns sync
knowns sync --instructions
```

Dùng `knowns init` để tạo project guidance files ban đầu. Dùng `knowns setup agents` để tạo hoặc refresh chỉ `KNOWNS.md` + `AGENTS.md`, `knowns setup <target>` cho full platform integrations, hoặc `knowns sync` để refresh generated files từ config.
