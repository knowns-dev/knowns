---
id: doc-6b90879582069ffc1bcdffed63fde6dc
title: Skills System
description: Skill definition, sharing, and sync across platforms
createdAt: '2026-01-23T04:07:56.363Z'
updatedAt: '2026-08-27T06:14:37.859Z'
tags: []
---

## Overview

Skills are AI workflow instructions bundled with Knowns. They are embedded in the binary and synced to platform-specific directories during `knowns setup` or `knowns sync`.

Skills are separate from MCP tools. MCP tools appear in AI clients as structured domain tools such as `tasks`, `docs`, `memory`, `search`, and `code`; skills are invoked through each agent's skill-command syntax.

| Platform | Skill syntax |
|---|---|
| Claude Code | `/kn-spec`, `/kn-flow`, `/kn-review` |
| Codex | `$kn-spec`, `$kn-flow`, `$kn-review` |

**Related:** @doc/ai/platforms

---

## How Skills Work

1. Skills are embedded in the Knowns binary as SKILL.md files
2. During `knowns setup <target>`, skills are copied to the platform directories you selected
3. `knowns sync --skills` re-syncs skills from the binary to platform dirs
4. AI assistants discover skills from their platform directory

> **Note:** `knowns init` no longer generates AI integration files or syncs skills. Use `knowns setup` after init to configure AI platforms.

---

## Synced Locations

Platform directories synced by `knowns setup` / `knowns sync`:

```text
.claude/skills/              # Claude Code
.agents/skills/              # OpenCode / Antigravity / Codex / Generic Agents
.kiro/skills/                # Kiro
```

Skills are synced as SKILL.md files. Claude Code uses `.claude/skills/`. OpenCode, Antigravity, Codex, and Generic Agents use `.agents/skills/`. Kiro uses `.kiro/skills/`.

---

## Setup Command

Configure AI integrations with the interactive selector:

```bash
knowns setup
```

Configure a specific platform:

```bash
knowns setup claude
knowns setup opencode
knowns setup codex
knowns setup kiro
knowns setup copilot
knowns setup all
```

Re-sync skills and instructions:

```bash
knowns sync
knowns sync --skills
knowns sync --instructions
```

---

## Built-in Skills

| Skill | Description |
|-------|-------------|
| `kn-init` | Initialize session, read docs, load memory, understand project |
| `kn-spec` | Create specification document for features (SDD) |
| `kn-flow` | Recommended approved-spec orchestration: plan, implement, test, review, verify |
| `kn-go` | Legacy full pipeline from approved spec without review gates |
| `kn-plan` | Take task, gather context, create implementation plan |
| `kn-research` | Search codebase, find patterns, explore before coding |
| `kn-handoff` | Cross-repo brief or API contract when work spans repositories |
| `kn-implement` | Execute plan, track progress, check acceptance criteria |
| `kn-test` | Turn spec Scenarios and ACs into tests; report unproven criteria |
| `kn-review` | Multi-perspective code review (P1/P2/P3 severity) |
| `kn-debug` | Structured debugging: triage -> fix -> learn |
| `kn-decision` | System Decision lifecycle: draft, triage, promote, supersede |
| `kn-verify` | Run SDD verification and coverage report |
| `kn-doc` | Create and update documentation |
| `kn-template` | List, run, or create code templates |
| `kn-extract` | Extract reusable patterns into docs, templates, and memory |
| `kn-commit` | Create conventional commit with verification |

## SDD Workflow

Recommended approved-spec path:

```text
Claude Code:
/kn-spec <feature-name>
/kn-flow @doc/<spec-path>

Codex:
$kn-spec <feature-name>
$kn-flow @doc/<spec-path>
```

Use `kn-go` only when you explicitly want the older no-review-gates pipeline.

---

## SKILL.md Format

```markdown
---
name: kn-init
description: Initialize session - read docs, load memory, understand project
---

Instructions for the AI workflow...
```

### Frontmatter

| Field | Description |
|-------|-------------|
| `name` | Skill identifier |
| `description` | Short description shown in skill list |

---

## Memory Integration

All skills participate in the memory loop:
- **Read skills** (init, research, plan, spec, flow, go, review, debug): search `type: "memory"` via unified search
- **Write skills** (implement, extract, debug): save patterns/decisions/failures with `memory({ action: "add", layer: "project" })`

---

## MCP vs CLI in Skills

Skills use MCP tools when available, with CLI as fallback:

- **Reading tasks/docs**: MCP `tasks({ action: "get" })` or CLI `knowns task <id> --plain`
- **Updating tasks**: MCP `tasks({ action: "update" })` or CLI `knowns task edit <id>`
- **Searching**: MCP `search({ action: "search" })` or CLI `knowns search "query" --plain`
- **Time tracking**: MCP `time({ action: "start" })` or CLI `knowns time start <id>`

MCP is preferred when available because it is faster (direct call vs spawning a process) and returns structured JSON.


## Portability and Mutation Boundaries

The embedded `SKILL.md` sources are platform-neutral workflow contracts. Platform-specific invocation syntax and sync destinations belong to setup/sync documentation, not to the workflow logic inside an individual skill.

- External tools are discovered and selected by capability, source type, freshness, and evidence quality; built-in skills do not require a named external research provider.
- `kn-research` does not mutate tasks, docs, memories, decisions, or source files unless persistence is explicitly authorized.
- Generated platform copies are overwritten by `knowns sync`; edit only `internal/instructions/skills/kn-*/SKILL.md`.
- All 17 built-in skills use the shared response order: goal/result, key details, and an optional natural next action.
- Automated source and sync tests enforce provider neutrality, mutation boundaries, response ordering, template examples, Decision lifecycle rules, and critical approval/verification gates. A contract test also asserts every embedded skill appears in the shared roster sentence, so the list cannot drift as skills are added.
