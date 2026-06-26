---
title: Agent Skills
description: Pattern for creating and managing Knowns agent skills across AI platforms
createdAt: '2026-01-17T06:06:37.006Z'
updatedAt: '2026-06-26T03:40:06.464Z'
tags:
  - pattern
  - agents
  - skills
  - claude-code
  - codex
---

## Overview

Knowns CLI integrates with agent skills: workflow templates that can be invoked through each AI platform's skill-command syntax.

Skills are not MCP tools. MCP tools are structured domain APIs such as `tasks`, `docs`, `memory`, `search`, and `code`. Skills orchestrate those tools plus CLI/code actions into higher-level workflows.

| Platform | Skill syntax | Skill path |
|---|---|---|
| Claude Code | `/kn-spec`, `/kn-flow`, `/kn-review` | `.claude/skills/` |
| Codex | `$kn-spec`, `$kn-flow`, `$kn-review` | `.agents/skills/` |
| OpenCode / Antigravity / Generic Agents | platform-specific skill invocation | `.agents/skills/` |
| Kiro | platform-specific skill invocation | `.kiro/skills/` |

## Skill Structure

```text
internal/instructions/skills/
├── kn-init/
│   └── SKILL.md
├── kn-plan/
│   └── SKILL.md
├── kn-flow/
│   └── SKILL.md
└── ...
```

## Naming Convention

- Folder name: `kn-<skill>`
- Examples: `kn-init`, `kn-plan`, `kn-flow`, `kn-review`
- Platform invocation is separate from the stored skill name.

## SKILL.md Format

```yaml
---
name: kn-init
description: Initialize session with project context
---

Instructions for the skill live here.
```

## Available Skills

| Skill | Description |
|-------|-------------|
| `kn-init` | Initialize session: read docs, list tasks, load project memories |
| `kn-spec` | Create spec with Socratic exploring phase (SDD workflow) |
| `kn-flow` | Recommended approved-spec orchestration: plan, implement, review, verify |
| `kn-plan` | Plan task implementation or generate tasks from a spec |
| `kn-implement` | Implement task, track progress, check ACs |
| `kn-research` | Research codebase before implementation |
| `kn-review` | Multi-perspective code review with P1/P2/P3 severity |
| `kn-commit` | Generate commit message and commit changes |
| `kn-extract` | Extract patterns, decisions, failures, and memory |
| `kn-doc` | Create and update documentation |
| `kn-template` | Generate code from templates |
| `kn-verify` | SDD verification and coverage reporting |
| `kn-go` | Legacy full pipeline from approved spec without review gates |
| `kn-debug` | Structured debugging: triage, reproduce, fix, learn |

## Memory Integration

All skills participate in the memory loop:

- Read skills (`init`, `research`, `plan`, `spec`, `flow`, `go`, `review`, `debug`) search `type: "memory"` via unified search.
- Write skills (`implement`, `extract`, `debug`) save patterns/decisions/failures with `memory({ action: "add", layer: "project" })`.

## Workflow

### Manual flow (step by step)

```text
/kn-init -> /kn-research -> /kn-spec -> /kn-plan --from -> /kn-plan <id> -> /kn-implement <id> -> /kn-review -> /kn-commit -> /kn-extract
```

### Recommended approved-spec flow

```text
Claude Code:
/kn-spec <feature-name>
/kn-flow @doc/<spec-path>

Codex:
$kn-spec <feature-name>
$kn-flow @doc/<spec-path>
```

`kn-flow` discovers or generates linked tasks, gates parallel work, runs plan -> implement -> review, and verifies the integrated result.

### Legacy go mode

```text
/kn-spec -> approve -> /kn-go specs/<name>
```

Use `kn-go` only when the user explicitly wants the older no-review-gates pipeline.

### Debugging flow

```text
/kn-debug -> /kn-review -> /kn-commit
```

## Sync Commands

```bash
knowns sync                   # Sync all configured artifacts
knowns sync --skills          # Sync skills only
knowns sync --instructions    # Sync instruction files only
```

Sync always overwrites generated files. The `--force` flag is deprecated.

## Implementation Details

### Source Location

Skills source lives in `internal/instructions/skills/kn-*/SKILL.md`. These are embedded into the Go binary and synced to platform dirs during `knowns setup` / `knowns sync`.

### Sync Function

Skills are synced to the target platform's configured skill directory, such as `.claude/skills/<folder-name>/SKILL.md` or `.agents/skills/<folder-name>/SKILL.md`.
