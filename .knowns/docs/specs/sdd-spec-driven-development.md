---
title: SDD (Spec-Driven Development)
createdAt: '2026-02-03T18:03:17.210Z'
updatedAt: '2026-02-03T18:03:54.018Z'
description: >-
  Spec-Driven Development workflow - flexible, opt-in approach to write specs
  before code
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

### `/kn:spec <name>`

Create a spec document in `specs/` folder.

**Behavior:**
1. Ask: "What feature are you speccing?"
2. Generate spec at `.knowns/docs/specs/<name>.md`
3. Include: Overview, Requirements, ACs, Scenarios
4. Ask: "Review. Approve, edit, or add more?"
5. When approved, set `status: approved`
6. Suggest: "Create tasks? (`/kn:plan --from @doc/specs/<name>`)"

### `/kn:verify`

Run validation with SDD-awareness.

**Checks:**
- Tasks linked to spec → ✅
- Tasks WITHOUT spec → ⚠️ warning
- Spec `approved` but no tasks → ⚠️ warning
- Spec `implemented` but tasks not done → ⚠️ warning
- All ACs checked → ✅
- ACs incomplete → ⚠️ warning

**Output:**
```
SDD Status Report
═══════════════════════════════════════
Specs:    3 total | 2 approved | 1 draft
Tasks:    8 total | 5 done | 2 in-progress | 1 todo
Coverage: 6/8 tasks linked to specs (75%)

⚠️ Warnings:
  - task-12 has no spec reference
  - specs/payment: 1/3 ACs incomplete

✅ Passed:
  - All references resolve
  - specs/user-auth: fully implemented
```

**Exit code:** Always 0 (warn, never block)

### `/kn:plan --from @doc/specs/<name>`

Generate tasks from spec.

**Behavior:**
1. Read spec document
2. Break requirements into tasks
3. Each task gets:
   - Title from requirement
   - ACs copied from spec
   - `spec: specs/<name>` field
4. Show generated tasks, ask approval
5. Add to backlog

## Workflow Flows

### Full SDD (large features)

```
/kn:spec user-auth                    → Create spec in specs/
/kn:plan --from @doc/specs/user-auth  → Generate tasks
/kn:init                              → Read context
/kn:implement 42                      → Code (AI reads spec via MCP)
/kn:verify                            → Check completion
/kn:commit                            → Ship
```

### Normal Flow (small features)

```
/kn:plan 42                           → Plan from task
/kn:implement 42                      → Code
/kn:commit                            → Ship (verify runs auto)
```

### Quick Fix (bugs)

```
/kn:implement 42                      → Just code
/kn:commit                            → Ship
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
- [ ] `/kn:spec` skill
- [ ] `/kn:verify` skill
- [ ] `/kn:plan --from` support

### Phase 2: Web UI

- [ ] TaskDetail: spec section
- [ ] DocsPage: specs folder view
- [ ] Spec editor mode

### Phase 3: Enhancements

- [ ] Auto status updates
- [ ] Coverage analytics
- [ ] Spec templates

## Example Session

```
You: /kn:spec user-auth

Claude: 📋 Creating spec in specs/user-auth.md

        # User Authentication

        ## Overview
        JWT-based auth with login, register, token refresh.

        ## Requirements

        ### REQ-1: User Registration
        - [ ] AC-1.1: POST /auth/register creates user
        - [ ] AC-1.2: Password hashed with bcrypt
        - [ ] AC-1.3: Duplicate email returns 409

        ### REQ-2: User Login
        ...

        Saved to .knowns/docs/specs/user-auth.md
        Approve, edit, or add more?

You: Approve. Create tasks.

Claude: ✅ Spec approved. Generated 4 tasks:
        - task-43: Registration (spec: specs/user-auth)
        - task-44: Login (spec: specs/user-auth)
        - task-45: Token refresh (spec: specs/user-auth)
        - task-46: Auth middleware (spec: specs/user-auth)

You: /kn:implement 43

Claude: [Reads @doc/specs/user-auth via MCP, implements, checks ACs]

        ✓ AC-1.1: DONE
        ✓ AC-1.2: DONE
        ✓ AC-1.3: DONE

You: /kn:verify

Claude: SDD Status: specs/user-auth 25% complete (1/4 tasks)
        ✅ REQ-1: all ACs met
        ⚠️ REQ-2, REQ-3, REQ-4: not started
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
