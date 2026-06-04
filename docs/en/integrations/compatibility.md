# Compatibility

This document explains the main compatibility behaviors Knowns preserves when platform integrations or generated artifact layouts change.

## Why this exists

Knowns manages generated files such as:

- skills directories
- MCP configuration files
- instruction files
- runtime hooks

As integrations evolve, older projects may still contain previously generated layouts. Knowns tries to preserve safe compatibility instead of breaking those projects immediately.

## Skills directory compatibility

Current primary mapping:

- `.claude/skills` -> Claude Code
- `.agents/skills` -> OpenCode, Codex, Antigravity, Generic Agents
- `.kiro/skills` -> Kiro

### Legacy behavior

The `.agent/skills` legacy path has been removed. All agent-compatible platforms now use `.agents/skills`.

## Platform-specific MCP compatibility

Knowns now manages project-local MCP config for several platforms, for example:

- Claude Code -> `.mcp.json`
- Kiro -> `.kiro/settings/mcp.json`
- Cursor -> `.cursor/mcp.json`
- Codex -> `.codex/config.toml`
- OpenCode -> `opencode.json`

For Antigravity, the MCP config is global:

- `~/.gemini/antigravity/mcp_config.json`

## Init, sync, and update

### `knowns init`

Creates the project structure, git tracking, semantic search setup, and selected project instruction shims (`KNOWNS.md`, default `CLAUDE.md` + `AGENTS.md`).

### `knowns setup`

Generates AI platform artifacts such as skills, MCP configs, platform-specific configs, runtime hooks, and any additional instruction files for the selected target. Use `knowns setup agents` when you only need `KNOWNS.md` + `AGENTS.md`.

### `knowns sync`

Re-applies `.knowns/config.json` to the current machine.

Use it after:

- cloning a repository
- wanting generated files to match the current config again

### `knowns update`

Updates the CLI, then refreshes generated artifacts that depend on the binary or config policy.

## Recommendation

- For new projects, follow the current primary layout.
- For older projects, let `knowns sync` and `knowns update` preserve compatibility first, then migrate deliberately when needed.
