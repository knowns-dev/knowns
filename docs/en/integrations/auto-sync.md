# Auto Sync

Knowns uses `knowns sync` and `knowns update` to keep generated artifacts aligned with the current binary and project config.

## What gets synced

- instruction files
- skills
- MCP config
- platform-specific config
- git integration
- semantic setup and indexing

## Related commands

```bash
knowns sync
knowns sync --skills
knowns sync --instructions
knowns update
```

## Legacy note

The `.agent/skills` legacy path has been removed. All agent-compatible platforms now use `.agents/skills`.
