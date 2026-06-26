# AI Workflow

Choose the right workflow for the task you are about to do. All flows assume the AI can use the `kn-*` skills family when available.

Skills are not MCP tools. They are agent workflow commands synced to the agent's skills directory. MCP tools appear in `codex mcp` as domain tools such as `tasks`, `docs`, `memory`, `search`, and `code`.

| Platform | Skill syntax |
|---|---|
| Claude Code | `/kn-spec`, `/kn-flow`, `/kn-review` |
| Codex | `$kn-spec`, `$kn-flow`, `$kn-review` |

The examples below use Claude Code's `/kn-*` syntax. In Codex, replace `/` with `$`.

Use this guide when you need to decide whether work should go through full spec-driven development, a normal task flow, or a quick-fix path.

## Choose your flow

| Flow | When to use | Typical sequence |
|---|---|---|
| Full SDD | large features, new systems, cross-cutting work | init -> research -> spec -> flow -> extract |
| Normal | small features, enhancements, well-understood tasks | init -> plan -> implement |
| Quick Fix | bug fixes, hotfixes, small repairs | init -> implement |

## Why research comes before spec

Before writing a spec, the AI often needs enough context to avoid drafting the wrong requirements.

Use research first when:

- the codebase area is unfamiliar
- the feature touches existing patterns or constraints
- you need to see how similar functionality already works

This is why the full SDD path below starts with `research` before `spec`.

## What `kn-research` searches

`kn-research` starts with project-owned context before going outside the repo:

- Knowns `search` and `retrieve` for docs, tasks, memory, and decisions
- Knowns `code` tools for symbols, definitions, references, diagnostics, and safe code navigation
- specialized external MCP providers, when available, for upstream or library facts such as Context7/library docs, GitHub/source MCP, or official docs MCP
- general web search only when a specialized MCP provider is unavailable, insufficient, or the user explicitly asks for internet research

For large research scopes, the skill may split the work into independent tracks and use sub-agents when the runtime exposes sub-agent tools. External findings should support local source-of-truth docs, tasks, and source files, not replace them silently.

## Full SDD flow

Use this for large features or changes that deserve a spec first.

### 1. Initialize session

```text
/kn-init
```

Reads project context, guidance, docs, and current working state.

### 2. Research first

```text
/kn-research
```

Use this step to gather enough project and upstream context before writing a spec.

### 3. Create spec

```text
/kn-spec user-auth
```

The AI creates a spec document that typically includes:

- overview and requirements
- acceptance criteria
- scenarios and edge cases

### 4. Run the approved spec flow

After reviewing and approving the spec, use `kn-flow` for the normal end-to-end SDD path:

```text
/kn-flow @doc/specs/user-auth
```

`kn-flow` discovers or generates linked tasks, schedules safe execution, plans, implements, runs review, fixes blocking findings, and verifies the spec/task set.

In Codex, `$kn-flow` may spawn sub-agents automatically after it reports the schedule, but only for parallel-safe task waves. Use `--sequential` when you want to force all work through the main context.

### Manual task-only path

If you only want to generate tasks and execute them manually, use:

```text
/kn-plan --from @doc/specs/user-auth
```

The AI breaks the spec into tasks and maps them back to spec acceptance criteria.

Then run individual tasks yourself:

```text
/kn-implement 42
```

### 5. Verify

```text
/kn-verify
```

Typical checks include:

- acceptance criteria coverage
- reference integrity
- spec/task consistency

### 6. Extract reusable knowledge

```text
/kn-extract
```

Use this when the implementation produced a reusable pattern, decision, or lesson worth keeping.

## Normal flow

Use this for smaller features where the task already exists and the problem is well understood.

1. `/kn-init`
2. `/kn-plan 42`
3. `/kn-implement 42`

## Quick Fix flow

Use this for bug fixes, hotfixes, or small repairs.

1. `/kn-init`
2. `/kn-implement 42`

## When to use `kn-flow`

Use `kn-flow` when you have an approved spec or a task wave and want the normal orchestrated workflow:

- task discovery or generation
- planning
- implementation
- code review via `kn-review`
- integration and verification

Typical approved-spec path:

```text
/kn-spec user-auth
(approve the spec)
/kn-flow @doc/specs/user-auth
```

In Codex, use `$kn-spec` and `$kn-flow` instead. `$kn-flow` can delegate parallel-safe waves to sub-agents; add `--sequential` to opt out.

## When to use `kn-go`

`kn-go` is the legacy no-review-gates pipeline for approved specs.

Use `kn-go` when:

- the spec is already approved
- you want task generation, planning, implementation, verification, and commit preparation to move as one continuous flow
- you do not need to review each task individually before implementation

Prefer `/kn-flow` for normal approved-spec execution. Prefer `/kn-plan` + `/kn-implement` when:

- you want to inspect or adjust each task before coding
- the spec is still evolving
- you want tighter review checkpoints between phases

## When to use `kn-debug`

Use `kn-debug` when implementation is blocked by an actual failure rather than missing planning.

Typical cases:

- build or type errors
- failing tests
- runtime crashes or exceptions
- integration failures
- a task is blocked and the root cause is still unclear

Use `kn-debug` instead of continuing normal implementation when the next useful action is to reproduce, diagnose, and fix the failure systematically.

## When to use `kn-extract`

Use `kn-extract` when the work you just completed produced something reusable that should not remain buried in a single task or chat session.

Typical cases:

- you discovered a repeatable implementation pattern
- you made a project-level decision that future work should follow
- you found a failure mode and its fix should be remembered
- you want to turn ad-hoc implementation knowledge into docs, memory, or templates

Use `kn-extract` near the end of a task or after verification, once you know the result is worth preserving for future humans and agents.

## Skill reference

| Skill | Purpose |
|---|---|
| `/kn-init` | Load project context |
| `/kn-research` | Explore project context, code, and relevant external MCP/web sources |
| `/kn-spec` | Create a spec document |
| `/kn-flow` | Orchestrate an approved spec or task wave |
| `/kn-plan` | Create an implementation plan |
| `/kn-implement` | Execute the work |
| `/kn-verify` | Check ACs, refs, and consistency |
| `/kn-review` | Review implemented work |
| `/kn-extract` | Capture reusable knowledge |
| `/kn-doc` | Work with docs |
| `/kn-template` | Run templates |
| `/kn-debug` | Debug blocked or failing work |

## CLI fallback

If skills are not available in the runtime, use the CLI directly.

```bash
# Initialize context manually
knowns doc list --plain
knowns doc "readme" --plain --smart

# Take a task
knowns task edit 42 -s in-progress -a @me
knowns time start 42

# Add plan
knowns task edit 42 --plan $'1. Research\n2. Implement\n3. Test'

# Mark ACs and add notes
knowns task edit 42 --check-ac 1
knowns task edit 42 --append-notes "Completed feature X"

# Finish
knowns time stop
knowns task edit 42 -s done
```

## Use separate sessions when useful

For larger work, it is often better to keep separate AI sessions per task or per phase.

Examples:

- one session for research
- one session for spec and planning
- one session for implementation

This reduces the chance of context compaction and makes each session easier to reason about.

## Definition of done

As a rule of thumb, a task is done when:

- acceptance criteria are checked
- notes or implementation details are recorded
- any active timer for the task has been stopped
- relevant validation or tests pass
- task status is updated appropriately

## Related

- [Task Management](./task-management.md)
- [AI Agent Guide](./ai-agent-guide.md)
- [Workflow](./workflow.md)
