# Configuration

Knowns stores project configuration in `.knowns/config.json`.

This file describes what the project wants Knowns to manage locally, including platform integrations, semantic search settings, and generated artifact behavior.

## Example

```json
{
  "name": "my-project",
  "settings": {
    "gitTrackingMode": "git-tracked",
    "gitTracking": {
      "tasks": true,
      "docs": true,
      "templates": true,
      "memories": false
    },
    "semanticSearch": {
      "enabled": true,
      "model": "multilingual-e5-small",
      "provider": "local",
      "dimensions": 384
    },
    "platforms": [
      "claude-code",
      "opencode",
      "codex",
      "kiro",
      "antigravity",
      "cursor",
      "gemini",
      "copilot",
      "agents"
    ],
    "lsp": {
      "enabled": true
    }
  }
}
```

## Important settings

### `name`

The project name shown in Knowns surfaces.

### `settings.gitTrackingMode`

Controls how Knowns manages Git-related generated content.

Supported values:

- `git-tracked`
- `git-ignored`
- `none`

Behavior:

- `git-tracked`: keep `.knowns/` content tracked in Git
- `git-ignored`: keep config/docs/templates tracked while leaving some local data out of Git depending on generated ignore rules
- `none`: do not let Knowns manage `.gitignore`

### `settings.gitTracking`

Per-section git tracking toggles. Controls which `.knowns/` subdirectories are included or excluded in `.gitignore`.

| Field | Default | Description |
|-------|---------|-------------|
| `tasks` | `true` | Track task markdown files |
| `docs` | `true` | Track documentation files |
| `templates` | `true` | Track code generation templates |
| `memories` | `false` | Track AI memory entries |

### `settings.semanticSearch`

Controls local semantic search.

Relevant fields:

- `enabled`
- `model`
- `provider` (`"local"`, `"ollama"`, or a provider ID registered with `knowns provider add`)
- `dimensions`

Common behavior:

- `knowns init` can set these values
- `knowns settings` shows supported Local ONNX models with downloaded/not downloaded status
- Selecting a missing Local ONNX model in `knowns settings` asks before downloading and saving it
- `knowns provider add` and `knowns model add --provider <id> <model-name>` configure API-backed embedding models
- `knowns sync` can re-apply the semantic setup
- `knowns search --reindex` rebuilds the local index

### `settings.lsp`

Controls LSP-based code intelligence.

- `enabled`: whether LSP servers are started for code navigation

### `settings.platforms`

Declares which platform integrations Knowns should manage.

Supported values:

- `claude-code`
- `opencode`
- `codex`
- `kiro`
- `antigravity`
- `cursor`
- `gemini`
- `copilot`
- `agents`

This setting affects what `knowns setup`, `knowns sync`, and `knowns update` create or refresh.

Examples of managed artifacts:

- instruction files
- skills
- MCP config
- runtime hooks
- platform-specific config files

### `settings.enableChatUI`

Controls whether the browser UI exposes the chat-oriented experience.

### `settings.autoSyncOnUpdate`

Controls whether generated artifacts should be refreshed after upgrading the CLI.

## Practical rules

### When to edit config manually

You can edit `.knowns/config.json` directly if you know what you are doing, but the normal path is:

- `knowns init` for first-time setup (project structure + git tracking)
- `knowns init` also creates selected lightweight project instruction shims such as `CLAUDE.md` and `AGENTS.md`
- `knowns setup <target> --global` for normal personal AI platform integrations such as MCP/config files, skills, and runtime hooks
- `knowns setup <target>` only when you intentionally want repo-local integration files
- `knowns setup agents` when you only need repo-local agent shims
- `knowns settings` for the interactive project settings center
- `knowns settings --global` for defaults reused by future `knowns init` runs
- `knowns config get/set/list/reset` for scriptable config access
- `knowns sync` to re-apply config to the current machine

### Settings and config shorthands

```bash
# Interactive project settings UI
knowns settings
# Shows:
#   Project
#   Git Tracking
#   AI Platforms
#   Search
#   Code Intelligence
#   Browser / Chat UI
#   Maintenance
#   Done

# Defaults for future projects
knowns settings --global

# Or set directly via the scriptable config API
knowns config set embedding true       # Enable semantic search
knowns config set lsp true             # Enable LSP globally
knowns config set lsp.go true          # Enable LSP for Go
knowns config set enableChatUI true    # Enable chat UI

# Git Tracking (per-section)
knowns config set gitTracking.tasks true
knowns config set gitTracking.memories false
```

Changing `gitTracking.*` toggles automatically regenerates `.gitignore`.

Interactive `knowns init` needs a terminal at least 90 columns wide. If the terminal is too small, Knowns prints resize and `--no-wizard` guidance and stops without initializing by defaults.

### When to use `knowns sync`

Use `knowns sync` after:

- cloning a repo with existing `.knowns/`
- updating the CLI
- wanting to restore generated artifacts to match config

### Platform-related compatibility

Current skills mapping:

- `.claude/skills` -> Claude Code
- `.agents/skills` -> OpenCode, Codex, Antigravity, Generic Agents
- `.kiro/skills` -> Kiro

## Related commands

```bash
knowns init
knowns setup
knowns settings
knowns sync
knowns config set <key> <value>
knowns config get <key>
knowns model list
knowns model download multilingual-e5-small
knowns search --status-check
knowns search --reindex
```
