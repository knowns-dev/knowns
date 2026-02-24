# Multi-Platform Support

Knowns supports multiple AI platforms, automatically configured during project initialization.

---

## Supported Platforms

| Platform | Skills | MCP | Instruction File |
|----------|--------|-----|------------------|
| **Claude Code** | `.claude/skills/` | `.mcp.json` | `CLAUDE.md` |
| **Antigravity (Gemini CLI)** | `.agent/skills/` | `~/.gemini/antigravity/mcp_config.json` | `GEMINI.md` |
| **GitHub Copilot** | - | - | `.github/copilot-instructions.md` |
| **Cursor** | `.cursor/rules/` | MCP support | - |
| **Windsurf** | - | - | `.windsurfrules` |
| **Cline** | `.clinerules/` | MCP support | - |

---

## Auto-Configuration

When running `knowns init`, all major platforms are automatically configured:

```bash
knowns init my-project
```

**Output:**
```
✓ Project initialized: my-project
✓ Created 10 skills for claude
✓ Created 10 skills for antigravity
✓ Created .mcp.json for Claude Code MCP auto-discovery
✓ Created Antigravity MCP config
✓ Created: CLAUDE.md
✓ Created: GEMINI.md
✓ Created: AGENTS.md
✓ Created: .github/copilot-instructions.md
```

---

## Platform Details

### Claude Code

**Skills Directory:** `.claude/skills/`

Each skill is a folder containing `SKILL.md`:

```
.claude/skills/
├── kn-init/
│   └── SKILL.md
├── kn-plan/
│   └── SKILL.md
├── kn-implement/
│   └── SKILL.md
└── ...
```

**MCP Config:** `.mcp.json` (project root)

```json
{
  "mcpServers": {
    "knowns": {
      "command": "npx",
      "args": ["-y", "knowns", "mcp"]
    }
  }
}
```

**Instruction File:** `CLAUDE.md`

Contains guidelines for Claude Code agent.

---

### Antigravity (Gemini CLI)

**Skills Directory:** `.agent/skills/`

Same structure as Claude Code:

```
.agent/skills/
├── kn-init/
│   └── SKILL.md
├── kn-plan/
│   └── SKILL.md
└── ...
```

**MCP Config:** `~/.gemini/antigravity/mcp_config.json` (user home)

```json
{
  "mcpServers": {
    "knowns": {
      "command": "npx",
      "args": ["-y", "knowns", "mcp"]
    }
  }
}
```

**Instruction File:** `GEMINI.md`

---

### GitHub Copilot

**Instruction File:** `.github/copilot-instructions.md`

GitHub Copilot reads this file to understand project context.

---

### Cursor

**Rules Directory:** `.cursor/rules/`

**MCP Config:** Configured in Cursor settings.

---

## Version Tracking

Each platform directory contains a `.version` file to track the synced version:

```
.claude/skills/.version
.agent/skills/.version
```

**Content:**
```json
{
  "cliVersion": "0.11.3",
  "syncedAt": "2026-02-24T07:18:07.960Z"
}
```

See: [Auto-Sync](./auto-sync.md)

---

## Manual Sync

To manually sync skills:

```bash
# Sync all
knowns sync

# Force overwrite
knowns sync --force

# Sync with specific mode
knowns sync --mode mcp   # MCP tools (default)
knowns sync --mode cli   # CLI commands
```

---

## Instruction Files

All instruction files use **Unified Guidelines** (CLI + MCP):

| File | Platform | Auto-created |
|------|----------|--------------|
| `CLAUDE.md` | Claude Code | ✓ |
| `GEMINI.md` | Antigravity | ✓ |
| `AGENTS.md` | Generic AI agents | ✓ |
| `.github/copilot-instructions.md` | GitHub Copilot | ✓ |

**Markers:**

Guidelines are wrapped in markers to allow updates:

```markdown
<!-- KNOWNS GUIDELINES START -->
# Knowns Guidelines
...
<!-- KNOWNS GUIDELINES END -->
```

When syncing, only content between markers is updated; other parts of the file are preserved.

---

## Related

- [Auto-Sync](./auto-sync.md) - Automatic sync when version changes
- [Guidelines](./guidelines.md) - Guidelines system for AI agents
- [Configuration](./configuration.md) - Project configuration
