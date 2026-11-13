---
id: doc-430e9b78ddf8b273d3f4aa284cdd9a4d
title: 'Learning: MCP Setup Multi-Platform Registry'
description: Learnings from rewriting knowns mcp setup to support per-platform selection and 10 platforms
createdAt: '2026-04-30T12:58:14.440Z'
updatedAt: '2026-04-30T12:58:14.440Z'
tags:
  - learning
  - cli
  - mcp
  - platforms
---

# Learning: MCP Setup Multi-Platform Registry

Source: `internal/cli/mcp.go` rewrite (April 2026)

## Patterns

### Platform Registry Pattern
- **What:** Data-driven registry of platform configs using a slice of structs with `id`, `label`, `scope`, and `setup func`. CLI args map to registry entries, replacing hardcoded if/else branches.
- **When to use:** Any CLI command that needs to operate across multiple targets (platforms, runtimes, environments). Especially useful when the list of targets grows over time.
- **Example:** `mcpPlatforms` slice in `internal/cli/mcp.go` — each entry is self-contained with its own setup function, making it trivial to add new platforms.

### Unified Setup Function Signature
- **What:** All platform setup functions normalized to `func(projectRoot string) (path string, err error)`. Previous code had inconsistent signatures.
- **When to use:** When building a registry of operations that need uniform dispatch.

## Decisions

### Reuse init.go config functions
- **Chose:** Delegate to existing `create*Quiet` functions from `init.go`
- **Over:** Duplicating config creation logic in `mcp.go`
- **Tag:** GOOD_CALL
- **Outcome:** Zero duplication, behavior stays consistent between `knowns init` and `knowns mcp setup`
- **Recommendation:** Always check `init.go` and `sync.go` before writing new platform config logic — the function likely already exists.

### Positional args over per-platform flags
- **Chose:** `knowns mcp setup claude kiro antigravity` (positional args)
- **Over:** `knowns mcp setup --claude --kiro --antigravity` (boolean flags)
- **Tag:** GOOD_CALL
- **Outcome:** Cleaner UX, shell completion works naturally, scales to any number of platforms without flag explosion.
- **Recommendation:** Use positional args for target selection when the set is open-ended. Use flags for behavioral modifiers (`--project`, `--global`).

### Claude Desktop path fix (macOS)
- **Chose:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Over:** `~/.claude/claude_desktop_config.json` (old, incorrect path)
- **Tag:** TRADEOFF
- **Outcome:** Correct for Claude Desktop app. The old path was the Claude Code CLI config, not Claude Desktop.
- **Recommendation:** Always verify platform config paths against official docs before hardcoding.

## Failures

No significant failures. The implementation was straightforward because most platform config functions already existed in `init.go`. The main gap was that the original `mcp setup` was a minimal stub that only wrote one global config."
