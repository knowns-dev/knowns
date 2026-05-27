# Skills

Skills are reusable workflow instructions embedded in the Knowns binary and synced to platform-specific directories.

## Current skill paths

- `.claude/skills` -> Claude Code
- `.agents/skills` -> OpenCode, Codex, Antigravity, Generic Agents
- `.kiro/skills` -> Kiro

## Setup

Skills are generated via `knowns setup <target>` or re-synced with `knowns sync --skills`:

```bash
knowns setup claude    # Syncs to .claude/skills/
knowns setup opencode  # Syncs to .agents/skills/
knowns setup kiro      # Syncs to .kiro/skills/
knowns sync --skills   # Re-syncs all configured platforms
```

## Notes

- `.agents/skills` is the primary path for agent-compatible platforms
- `knowns init` no longer syncs skills — use `knowns setup` after init
- `knowns sync --skills` is the entrypoint for regenerating skills after updates
