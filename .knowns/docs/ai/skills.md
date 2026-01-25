---
title: Skills System
createdAt: '2026-01-23T04:07:56.363Z'
updatedAt: '2026-01-23T04:12:51.307Z'
description: 'Skill definition, sharing, and sync across platforms'
tags:
  - feature
  - ai
  - skills
---
## Overview

Skills là instructions cho AI workflows. Định nghĩa một lần, sync sang nhiều platforms.

**Related:** @doc/ai/platforms

---

## Source of Truth

```
.knowns/skills/              # Define here
├── knowns-task/SKILL.md
├── knowns-doc/SKILL.md
└── custom-skill/SKILL.md

# Auto-sync
.claude/skills/              # Claude Code
.agent/skills/               # Antigravity
.cursor/rules/               # Cursor (converted)
~/.gemini/commands/          # Gemini CLI (converted)
```

---

## SKILL.md Format

```markdown
---
name: knowns-task
description: Work on Knowns tasks with proper workflow
triggers:
  - "work on task"
  - "take task"
---

# Task Workflow

Instructions here...
```

### Frontmatter

| Field | Description |
|-------|-------------|
| `name` | Skill identifier |
| `description` | Short description |
| `triggers` | Phrases that activate skill |

---

## Portable Format

**Claude Code** và **Antigravity** dùng cùng SKILL.md format:

```bash
# Symlink để share
ln -s .claude/skills .agent/skills

# Hoặc dùng Knowns sync
knowns skill sync
```

---

## Sharing Scopes

| Platform | Personal | Project | Team |
|----------|----------|---------|------|
| Claude Code | `~/.claude/skills/` | `.claude/skills/` | Plugins |
| Antigravity | `~/.gemini/antigravity/skills/` | `.agent/skills/` | git |
| Cursor | Settings | `.cursor/rules/` | Dashboard |
| Gemini CLI | `~/.gemini/commands/` | - | git |

---

## CLI Commands

```bash
# List skills
knowns skill list

# Create new skill
knowns skill create my-skill

# View skill
knowns skill view knowns-task

# Sync to platforms
knowns skill sync --all
knowns skill sync --platform claude,antigravity

# Export to specific format
knowns skill export --platform cursor

# Check status
knowns skill status
```

---

## Built-in Skills

| Skill | Description |
|-------|-------------|
| `knowns-task` | Task workflow |
| `knowns-doc` | Doc management |
| `knowns-commit` | Git commits |
| `knowns-init` | Session init |
| `knowns-research` | Codebase research |

---

## Custom Skills

```bash
# Create
knowns skill create deploy-staging

# Edit .knowns/skills/deploy-staging/SKILL.md
```

```markdown
---
name: deploy-staging
description: Deploy to staging environment
triggers:
  - "deploy to staging"
  - "staging deploy"
---

# Deploy to Staging

1. Run tests: `npm test`
2. Build: `npm run build`
3. Deploy: `./scripts/deploy-staging.sh`
4. Verify: Check staging URL
```

---

## Platform Conversion

Khi sync, skills được convert sang format phù hợp:

| Platform | Output Format |
|----------|---------------|
| Claude Code | `SKILL.md` (giữ nguyên) |
| Antigravity | `SKILL.md` (giữ nguyên) |
| Cursor | `.mdc` (frontmatter converted) |
| Gemini CLI | `.md` command file |
| Windsurf | Appended to `.windsurfrules` |


---

## Skill Modes: MCP vs CLI

Khi init, user chọn skill mode. Skills sẽ được generate với instructions phù hợp.

### Init Options

```bash
$ knowns init

? Skill instruction mode:
  ◉ Auto (recommended) - Use MCP when available, fallback to CLI
  ◯ MCP Only - Use MCP tools (mcp__knowns__*)
  ◯ CLI Only - Use CLI commands (knowns task/doc/...)
```

### Mode Comparison

| Mode | When to Use | Pros | Cons |
|------|-------------|------|------|
| **Auto** | Default | Best of both | Slightly complex |
| **MCP Only** | Full MCP support | Fast, structured | Limited features |
| **CLI Only** | No MCP / Legacy | Full features | Slower |

---

## Generated Skill Content

### Auto Mode (Recommended)

```markdown
---
name: knowns-task
description: Work on Knowns tasks
mode: auto
---

# Task Workflow

## View Task
{{#if mcp}}
Use MCP: `mcp__knowns__get_task({ "taskId": "{{id}}" })`
{{else}}
Use CLI: `knowns task {{id}} --plain`
{{/if}}

## Update Task
For simple updates (status, assignee):
{{#if mcp}}
`mcp__knowns__update_task({ "taskId": "{{id}}", "status": "in-progress" })`
{{/if}}

For complex updates (AC, plan, notes) - always use CLI:
\`\`\`bash
knowns task edit {{id}} --ac "New criterion"
knowns task edit {{id}} --plan "1. Step one"
knowns task edit {{id}} --check-ac 1
\`\`\`
```

### MCP Mode

```markdown
---
name: knowns-task
mode: mcp
---

# Task Workflow

## View Task
\`\`\`json
mcp__knowns__get_task({ "taskId": "{{id}}" })
\`\`\`

## Update Task
\`\`\`json
mcp__knowns__update_task({
  "taskId": "{{id}}",
  "status": "in-progress",
  "assignee": "@me"
})
\`\`\`

## Start Timer
\`\`\`json
mcp__knowns__start_time({ "taskId": "{{id}}" })
\`\`\`

> **Note:** For --ac, --plan, --notes use CLI fallback
```

### CLI Mode

```markdown
---
name: knowns-task
mode: cli
---

# Task Workflow

## View Task
\`\`\`bash
knowns task {{id}} --plain
\`\`\`

## Update Task
\`\`\`bash
knowns task edit {{id}} -s in-progress -a @me
knowns task edit {{id}} --ac "Criterion"
knowns task edit {{id}} --plan "1. Step"
\`\`\`

## Time Tracking
\`\`\`bash
knowns time start {{id}}
knowns time stop
\`\`\`
```

---

## Config: `.knowns/config.json`

```json
{
  "skills": {
    "mode": "auto",      // "auto" | "mcp" | "cli"
    "mcpFallback": true  // Use CLI when MCP not available
  }
}
```

---

## MCP vs CLI Feature Matrix

| Feature | MCP | CLI |
|---------|-----|-----|
| List tasks | ✅ `list_tasks` | ✅ `task list` |
| Get task | ✅ `get_task` | ✅ `task <id>` |
| Update status | ✅ `update_task` | ✅ `task edit -s` |
| **Add AC** | ❌ | ✅ `--ac` |
| **Check AC** | ❌ | ✅ `--check-ac` |
| **Set plan** | ❌ | ✅ `--plan` |
| **Add notes** | ❌ | ✅ `--notes` |
| Start timer | ✅ `start_time` | ✅ `time start` |
| Stop timer | ✅ `stop_time` | ✅ `time stop` |
| Get doc | ✅ `get_doc` | ✅ `doc <path>` |
| Search | ✅ `search_*` | ✅ `search` |

**Rule:** Complex task edits (AC, plan, notes) → Always CLI

---

## Auto-Detection

Skills có thể detect MCP availability:

```markdown
# In skill instructions

## Reading (prefer MCP if available)
- If MCP available: `mcp__knowns__get_task`
- Fallback: `knowns task <id> --plain`

## Writing (use appropriate tool)
- Simple updates: MCP `update_task` 
- Complex edits: CLI `knowns task edit --ac/--plan/--notes`
```

---

## Platform-Specific Generation

Khi sync, skills adapt theo platform capabilities:

| Platform | MCP Support | Generated Mode |
|----------|-------------|----------------|
| Claude Code | ✅ Full | Auto/MCP |
| Antigravity | ✅ Full | Auto/MCP |
| Gemini CLI | ✅ Full | Auto/MCP |
| Cursor | ✅ Full | Auto/MCP |
| Windsurf | ⚠️ Limited | CLI preferred |
| GitHub Copilot | ❌ None | CLI only |

```bash
# Sync respects platform capabilities
knowns skill sync --all

# Generated skills:
# .claude/skills/     → Auto mode (MCP + CLI)
# .agent/skills/      → Auto mode (MCP + CLI)
# .cursor/rules/      → Auto mode (MCP + CLI)
# .windsurfrules      → CLI mode (no MCP)
# .github/copilot-*   → CLI mode (no MCP)
```

---

## Changing Mode

```bash
# Change mode globally
knowns config set skills.mode mcp

# Regenerate all skills
knowns skill sync --regenerate

# Or per-skill override
knowns skill edit my-skill --mode cli
```


---

## Full MCP Support (Updated)

Với extended MCP tools, **MCP có thể làm mọi thứ CLI làm được**.

### Updated Feature Matrix

| Feature | CLI | MCP |
|---------|-----|-----|
| List/Get tasks | ✅ | ✅ |
| Create/Update tasks | ✅ | ✅ |
| **Add AC** | ✅ `--ac` | ✅ `add_acceptance_criteria` |
| **Check/Uncheck AC** | ✅ `--check-ac` | ✅ `check_acceptance_criteria` |
| **Set plan** | ✅ `--plan` | ✅ `set_plan` |
| **Set/Append notes** | ✅ `--notes` | ✅ `set_notes` / `append_notes` |
| Time tracking | ✅ | ✅ |
| Docs CRUD | ✅ | ✅ |
| Search | ✅ | ✅ |
| Templates | ✅ | ✅ `run_template` |

### Simplified Mode Selection

```bash
$ knowns init

? Skill instruction mode:
  ◉ MCP (recommended) - Faster, structured output
  ◯ CLI - Traditional commands
  ◯ Hybrid - MCP for reads, CLI for writes
```

### MCP Mode Skills (Recommended)

```markdown
---
name: knowns-task
mode: mcp
---

# Task Workflow

## 1. View Task
\`\`\`json
mcp__knowns__get_task({ "taskId": "{{id}}" })
\`\`\`

## 2. Take Task
\`\`\`json
mcp__knowns__update_task({
  "taskId": "{{id}}",
  "status": "in-progress",
  "assignee": "@me"
})
mcp__knowns__start_time({ "taskId": "{{id}}" })
\`\`\`

## 3. Add Acceptance Criteria
\`\`\`json
mcp__knowns__add_acceptance_criteria({
  "taskId": "{{id}}",
  "criterion": "User can perform action"
})
\`\`\`

## 4. Set Plan (wait for approval)
\`\`\`json
mcp__knowns__set_plan({
  "taskId": "{{id}}",
  "plan": "1. Research\
2. Implement\
3. Test"
})
\`\`\`

## 5. Check AC (after work done)
\`\`\`json
mcp__knowns__check_acceptance_criteria({
  "taskId": "{{id}}",
  "index": 1
})
mcp__knowns__append_notes({
  "taskId": "{{id}}",
  "notes": "✓ Completed: feature X"
})
\`\`\`

## 6. Complete
\`\`\`json
mcp__knowns__stop_time({ "taskId": "{{id}}" })
mcp__knowns__update_task({
  "taskId": "{{id}}",
  "status": "done"
})
\`\`\`
```

### Why MCP is Now Recommended

| Aspect | MCP | CLI |
|--------|-----|-----|
| **Speed** | ✅ Faster (direct call) | Slower (spawn process) |
| **Output** | ✅ Structured JSON | Text (needs parsing) |
| **Error handling** | ✅ Typed errors | String parsing |
| **Features** | ✅ Full parity | Full |
| **Availability** | Requires config | Always works |

### Fallback Strategy

Nếu platform không hỗ trợ MCP, skills auto-convert sang CLI:

```bash
knowns skill sync --all

# Platform có MCP → MCP instructions
# Platform không có MCP → CLI instructions (auto-converted)
```
