# Skills

Skills là reusable workflow instructions, embedded trong Knowns binary và sync ra platform-specific directories.

## Skill paths

- `.claude/skills` → Claude Code
- `.agents/skills` → OpenCode, Codex, Antigravity, Generic Agents
- `.kiro/skills` → Kiro

## Setup

Skills được tạo qua `knowns setup <target>` hoặc re-sync bằng `knowns sync --skills`:

```bash
knowns setup claude    # Sync vào .claude/skills/
knowns setup opencode  # Sync vào .agents/skills/
knowns setup kiro      # Sync vào .kiro/skills/
knowns sync --skills   # Re-sync tất cả platforms đã cấu hình
```

## Ghi chú

- `.agents/skills` là primary path cho agent-compatible platforms
- `knowns init` không còn sync skills — dùng `knowns setup` sau init
- `knowns sync --skills` là entrypoint để regenerate skills sau khi update
