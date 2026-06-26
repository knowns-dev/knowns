---
title: SDD (Spec-Driven Development)
description: Spec-Driven Development workflow - flexible, opt-in approach to write specs before code
createdAt: '2026-02-03T18:03:17.210Z'
updatedAt: '2026-06-26T03:46:40.055Z'
tags:
  - feature
  - spec
  - sdd
  - workflow
---

# SDD (Spec-Driven Development)

## Overview

SDD is a flexible, opt-in workflow that encourages writing specs before code. Unlike rigid frameworks like OpenSpec, Knowns SDD:

- **Warns, never blocks** — `validate` shows warnings, never prevents work
- **3 steps, not 4** — Spec → Build → Verify (simpler than propose → apply → archive)
- **AI-native** — AI reads specs via MCP automatically

## Philosophy

| Principle | Description |
|-----------|-------------|
| Flexible first | Developer chooses level: full SDD, partial, or skip |
| Encourage, don't block | Warnings only, exit code 0 always |
| AI-native | AI reads specs via MCP, no copy-paste |
| Specs in `specs/` folder | Organized at `.knowns/docs/specs/` |

## Spec Storage

Specs are stored in dedicated folder:

```
.knowns/docs/
├── specs/                    ← All specs here
│   ├── user-auth.md
│   ├── payment.md
│   └── search.md
├── patterns/
├── guides/
└── ...
```

**Reference format:** `@doc/specs/user-auth`

**Benefits:**
- Clean separation from other docs
- Easy discovery: `knowns doc list --folder specs`
- Web UI can filter/group by folder

## Spec Document Format

```yaml
---
title: "User Authentication"
description: "JWT-based auth with login, register, token refresh"
type: spec
status: draft | approved | implemented
created: 2024-01-15
tags: [spec, auth]
---
```

### Content Structure

```markdown
# User Authentication

## Overview
<1-2 sentence description>

## Requirements

### REQ-1: <Requirement Name>
<Description>

**Acceptance Criteria:**
- [ ] AC-1.1: <criteria>
- [ ] AC-1.2: <criteria>

**Scenarios:**
GIVEN <precondition>
WHEN <action>
THEN <expected result>

### REQ-2: <Requirement Name>
...

## References
- @doc/patterns/auth
- @template/auth-module

## Notes
<Additional context, constraints, trade-offs>
```

## Task Schema Changes

New `spec` field in task frontmatter:

```yaml
---
id: task-43
title: Implement user registration
spec: specs/user-auth    # Links to @doc/specs/user-auth
---
```

**CLI usage:**
```bash
knowns task create "Login endpoint" --spec specs/user-auth
knowns task edit 43 --spec specs/user-auth
knowns task list --spec specs/user-auth  # Filter by spec
```

## Skills

Skills are workflow commands, not MCP tools. Claude Code invokes them as `/kn-*`; Codex invokes the same skills as `$kn-*`.

### `kn-spec <name>`

Create a spec document in `specs/` folder.

**Behavior:**
1. Ask: "What feature are you speccing?"
2. Generate spec at `.knowns/docs/specs/<name>.md`
3. Include: Overview, Requirements, ACs, Scenarios
4. Ask: "Review. Approve, edit, or add more?"
5. When approved, set `status: approved`
6. Suggest the next path:
   - normal approved-spec execution: `kn-flow @doc/specs/<name>`
   - task generation only: `kn-plan --from @doc/specs/<name>`
   - legacy no-review-gates pipeline: `kn-go specs/<name>`

### `kn-flow @doc/specs/<name>`

Recommended approved-spec orchestration path.

**Behavior:**
1. Read the approved spec and linked tasks
2. Generate/preview tasks if the spec has none
3. Schedule tasks by dependency and write ownership
4. Run plan -> implement -> review for each task or safe wave
5. Run final SDD verification

### `kn-verify`

Run validation with SDD-awareness.

**Checks:**
- Tasks linked to spec -> pass
- Tasks WITHOUT spec -> warning
- Spec `approved` but no tasks -> warning
- Spec `implemented` but tasks not done -> warning
- All ACs checked -> pass
- ACs incomplete -> warning

**Exit code:** Always 0 (warn, never block)

### `kn-plan --from @doc/specs/<name>`

Generate tasks from spec without executing them.

**Behavior:**
1. Read spec document
2. Break requirements into tasks
3. Each task gets title, ACs, `spec: specs/<name>`, and `fulfills`
4. Show generated tasks and ask approval
5. Add approved tasks to backlog

Use this when you want manual task-by-task execution. Use `kn-flow` when the goal is to execute the approved spec end to end.

## Workflow Flows

### Full SDD (large features)

Recommended path for approved specs:

```text
Claude Code:
/kn-spec user-auth                    -> Create and approve spec
/kn-flow @doc/specs/user-auth         -> Plan, implement, review, verify
/kn-commit                            -> Ship when flow is clean

Codex:
$kn-spec user-auth
$kn-flow @doc/specs/user-auth
```

`kn-flow` discovers or generates linked tasks, schedules safe execution, runs plan -> implement -> review, then verifies the integrated result.

### Manual SDD (task-by-task)

Use this when you only want task generation or manual checkpoints:

```text
/kn-spec user-auth                    -> Create and approve spec
/kn-plan --from @doc/specs/user-auth  -> Generate tasks
/kn-plan <task-id>                    -> Plan one task
/kn-implement <task-id>               -> Code one task
/kn-review <task-id>                  -> Review one task
/kn-verify                            -> Check completion
/kn-commit                            -> Ship
```

### Legacy go mode

Use only when you explicitly want the older no-review-gates pipeline:

```text
/kn-go specs/user-auth
```

### Normal Flow (small features)

```text
/kn-plan 42                           -> Plan from task
/kn-implement 42                      -> Code
/kn-review 42                         -> Review
/kn-commit                            -> Ship
```

### Quick Fix (bugs)

```text
/kn-implement 42                      -> Just code
/kn-review 42                         -> Review fix
/kn-commit                            -> Ship
```

## CLI Changes Required

| Change | Priority | Description |
|--------|----------|-------------|
| Task `spec` field | P0 | Add to schema, CLI flags |
| `validate --sdd` | P0 | SDD-specific checks |
| `task list --spec` | P1 | Filter by spec |
| `doc create --type spec` | P2 | Auto-set folder to `specs/` |

## Task View with Spec

```
TASK: task-43
══════════════════════════════════════════
Title:       Implement user registration
Status:      in-progress
Spec:        @doc/specs/user-auth (REQ-1: User Registration)
             Progress: 1/3 tasks done

Acceptance Criteria:
  - [x] AC-1.1: POST /auth/register creates user
  - [x] AC-1.2: Password hashed with bcrypt
  - [ ] AC-1.3: Duplicate email returns 409

Related Tasks (same spec):
  - task-44: Implement login (todo)
  - task-45: Token refresh (todo)
```

## Implementation Phases

### Phase 1: MVP (CLI + Skills)

- [ ] Task schema: add `spec` field
- [ ] Validate: add SDD checks
- [ ] `/kn-spec` skill
- [ ] `/kn-flow` skill
- [ ] `/kn-verify` skill
- [ ] `/kn-plan --from` support

### Phase 2: Web UI

- [ ] TaskDetail: spec section
- [ ] DocsPage: specs folder view
- [ ] Spec editor mode

### Phase 3: Enhancements

- [ ] Auto status updates
- [ ] Coverage analytics
- [ ] Spec templates

## Example Session

```text
You: /kn-spec user-auth

Claude: Creating spec in specs/user-auth.md

        User Authentication

        Overview
        JWT-based auth with login, register, token refresh.

        Requirements

        REQ-1: User Registration
        - [ ] AC-1.1: POST /auth/register creates user
        - [ ] AC-1.2: Password hashed with bcrypt
        - [ ] AC-1.3: Duplicate email returns 409

        REQ-2: User Login
        ...

        Saved to .knowns/docs/specs/user-auth.md
        Approve, edit, or add more?

You: Approve. Run the flow.

Claude: Spec approved. Starting /kn-flow @doc/specs/user-auth.
        Generated or confirmed 4 linked tasks:
        - task-43: Registration (spec: specs/user-auth)
        - task-44: Login (spec: specs/user-auth)
        - task-45: Token refresh (spec: specs/user-auth)
        - task-46: Auth middleware (spec: specs/user-auth)

Claude: [Plans safe task waves, implements tasks, reviews each wave]

        Registration: reviewed and complete
        Login: reviewed and complete
        Token refresh: reviewed and complete
        Auth middleware: reviewed and complete

Claude: SDD Status: specs/user-auth complete (4/4 tasks)
        All linked task ACs are checked.
        Ready for /kn-commit.

Codex equivalent:
$kn-spec user-auth
$kn-flow @doc/specs/user-auth
```

## Design Decisions

### Why `specs/` folder?

| Aspect | `specs/` folder | `spec-*` prefix |
|--------|-----------------|-----------------|
| Organization | ✅ Clean separation | ❌ Mixed with docs |
| Discovery | `--folder specs` | Search by prefix |
| Reference | `@doc/specs/auth` | `@doc/spec-auth` |
| Web UI | Easy filter/group | Need tag filter |

### Why Warning-Only?

- Developers hate gates
- Small fixes don't need specs
- Trust the developer
- SDD is guidance, not enforcement

### Why 3 Steps?

OpenSpec: Propose → Feature File → Apply → Archive (4 steps, rigid)
Knowns SDD: Spec → Build → Verify (3 steps, flexible)

Specs are living documents, not frozen artifacts.
