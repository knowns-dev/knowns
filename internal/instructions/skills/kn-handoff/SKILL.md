---
name: kn-handoff
description: Use when a feature crosses repository boundaries and one side must hand work to the other - generates a self-contained frontend-to-backend brief or backend-to-frontend API contract
---

# Cross-Repo Handoff Documents

Produce the document that carries a feature between two repositories that do not share a Knowns store.

**Announce:** "Using kn-handoff to write the [brief|contract] for [handoff-id]."

**Core principle:** A HANDOFF DOC MUST BE READABLE IN A REPO THAT HAS NONE OF THIS REPO'S CONTEXT.

## When to Use

- Frontend has shaped a feature and backend must now research and build the API
- Backend has finished the work and frontend must now integrate against a settled contract
- Any two-repo split where the receiving side opens a fresh session with no shared history

## When NOT to Use

- Single-repo work -> use `/kn-spec` and `/kn-flow` directly
- Passing context between tasks inside one repo -> use normal refs and `/kn-plan`
- Recording a durable architectural choice -> use a Decision, not a handoff

## Inputs

- Mode: `brief` (this repo -> other repo) or `contract` (this repo -> the repo that sent a brief)
- `handoff-id`: reuse the existing id when replying; generate `hof-<yyyy-mm-dd>-<slug>` for a new one
- Source material: the spec, research findings, and completed tasks in this repo
- For `contract`: the brief being answered, so changes against it can be reported

## Two Modes Are Different Documents

| | `brief` (FE -> BE) | `contract` (BE -> FE) |
|---|---|---|
| Carries | questions and unconfirmed assumptions | settled, implemented fact |
| Authority | none, the receiver decides | authoritative for integration |
| Must not contain | receiver-side code, schema decisions, or claims stated as fact | unimplemented or speculative endpoints |
| Must contain | explicit open questions and risks | exact payloads, errors, and real examples |

Never blend the two. A brief that asserts backend design steals a decision that belongs to the backend developer. A contract that hedges leaves the frontend guessing.

## Handoff Identity

Every handoff document opens with this block, written as plain text:

```text
handoff-id:   hof-2026-08-24-order-refund
direction:    fe->be
version:      1
replies-to:   (none | hof-2026-08-24-order-refund brief v1)
source-repo:  knowns-web @ 3f9a1c2 (git@github.com:org/knowns-web.git)
target-repo:  knowns-api
generated:    2026-08-24
```

`handoff-id` is the only join key between the two repositories. Refer to a handoff by id and version, never by filesystem path, because paths differ per machine and per checkout.

## Cross-Repo Reference Rule

This rule overrides the normal project reference convention. It is not optional.

Inside a handoff document:

- Never write `@doc/<path>`, `@task-<id>`, or `@decision/<id>`. Those resolve against a Knowns store the receiving repo does not have, and this project rewrites doc refs when documents move, so a cross-repo ref rots without warning.
- Reference source files by repository name plus full path from the repository root, with a line number when it helps:

```text
knowns-api/internal/services/refund_service.go:142
knowns-web/src/features/orders/hooks/useRefund.ts:28
```

- Prefix the repository name always. The same relative path can exist on both sides.
- Spell out anything a ref would have carried. The document must stand alone with no lookups.

## Storage and Transport

Write two copies. They have different jobs.

| Location | Role |
|---|---|
| `<repo>/.knowns/docs/handoffs/<handoff-id>/<mode>.v<n>.md` | Source of truth. Committed to git, so teammates and CI have it. |
| `~/.knowns/handoffs/<handoff-id>/v<n>/` | Mirror for transport and external sync. Disposable, rebuildable. |

Alongside the mirror, write `source.json` recording repository name, git remote, branch, commit sha, mode, version, and content hash. That is what makes a handoff traceable once the originating branch has moved on.

Rules:

- Materialize real files. Never symlink into either location. This project's store reconciler rejects symlinked stores and silently skips symlinked `.md` files, so a symlinked handoff disappears from `doc list` and search with no error. A symlink also breaks on branch switch and cannot be synced to another machine.
- Never overwrite a published version. A revision becomes `v<n+1>` so the receiving side can diff and see what broke.
- When copying a handoff into the receiving repository, write it through the doc store so it receives a valid identity there. Keep `handoff-id` unchanged in the body as the join key.
- If a requested handoff cannot be found in the repo copy, the mirror, or an explicit path, stop and report it missing. Never reconstruct a contract from memory.

## Mode `brief`: Frontend to Backend

Sections, in order:

1. **Feature summary** - what is being built, why, and the main user flow from the frontend side.
2. **Frontend spec summary** - screens and components, important UI states, user actions to support, validation and business rules the frontend assumes.
3. **Backend needs and assumptions** - data the frontend needs, actions it must perform, APIs that look reusable, APIs that look new or changed, and behavior assumed but not confirmed.
4. **Suggested API contract** - proposed endpoints, request payloads, response shapes, error states to handle, and the loading, empty, success, and failure cases.
5. **Data requirements** - fields the UI needs, required versus optional, plus filtering, sorting, pagination, permission, and status logic.
6. **Questions for backend** - what is unclear, which constraints need confirming, which edge cases deserve research in the backend codebase.
7. **Risks and dependencies** - where frontend work waits on a backend decision, migration or technical debt concerns, anything that could change the frontend implementation.
8. **Acceptance criteria from the frontend perspective** - what must be true for backend work to unblock the frontend, and how the frontend will verify it is complete.

Hard rules for `brief`:

- Write no backend implementation code, no migrations, and no schema decisions. The backend developer knows that codebase better.
- Sections 3 and 4 exist to expose assumptions, not to assert them. Label every one, for example `ASSUMED, not verified:` or `PROPOSED, backend decides:`. An unlabeled assumption reads as a requirement and will be built as one.
- Frontend file references are welcome and should be concrete. Backend file references are acceptable only as "we noticed this, please confirm", never as instruction.

## Mode `contract`: Backend to Frontend

Sections, in order:

1. **Backend summary** - what was researched or completed, which modules were involved, which decisions were made and why.
2. **Final API contract** - endpoint paths, HTTP methods, auth and permission requirements, request payloads, response payloads, worked example request and response for each endpoint, and every error response with its meaning.
3. **Data model and field details** - fields exposed to the frontend, required versus optional, enums and statuses and types, default values, and which fields may be null or absent.
4. **Business logic handled by the backend** - validation performed, permission checks, state transitions, edge cases already covered.
5. **Business logic the frontend still handles** - validation and UI rules that remain the frontend's job, plus assumptions from the brief that no longer hold.

Hard rules for `contract`:

- Section 2 is the reason the document exists. Give real examples, not shapes described in prose.
- Report every divergence from the brief explicitly, including anything proposed and rejected, and say why. Silent divergence is how frontend integration breaks.
- Describe only what is implemented and verified. Planned work belongs in a separate note, clearly marked as not yet available.

## Handoff Lifecycle

A handoff has a state, and the state governs cleanup:

| State | Meaning |
|---|---|
| `open` | brief published, waiting for the other side |
| `answered` | contract returned |
| `consumed` | the receiving side has produced a spec from it |

- Only `consumed` handoffs become archive-eligible after the configured age.
- An `open` handoff past its age is a stale request, not garbage. Report it, do not remove it.
- The repository copy is project memory and is archived, never auto-deleted. It is the record of why an endpoint has the shape it has.
- The mirror under `~/.knowns/handoffs/` is a cache and may be purged outright once expired.
- Deleting any handoff permanently requires explicit user approval.

## Final Response Contract

All built-in skills in scope must end with the same user-facing information order: `kn-init`, `kn-spec`, `kn-flow`, `kn-go`, `kn-plan`, `kn-research`, `kn-handoff`, `kn-implement`, `kn-test`, `kn-review`, `kn-debug`, `kn-decision`, `kn-verify`, `kn-doc`, `kn-template`, `kn-extract`, and `kn-commit`.

Required order for the final user-facing response:

1. Goal/result - state which handoff document was written, at which id and version, in which direction.
2. Key details - include both written paths, unresolved questions or assumptions carried, and divergences from the brief when answering one.
3. Next action - recommend a concrete follow-up command only when a natural handoff exists.

Keep this concise for CLI use. Skill-specific content may extend the key-details section, but must not replace or reorder the shared structure.

Do not manage platform-synced skill copies; this source defines the built-in workflow contract.

For `kn-handoff`, the key details should cover:

- the `handoff-id` and version
- the repository copy path and the mirror path
- open questions carried, for a brief
- divergences from the brief, for a contract

## Next Step Suggestion

- brief written and ready to send -> stop, the other repository picks it up
- contract received and read -> `/kn-spec` to shape the integration spec
- context still thin before writing -> `/kn-research <topic>` across both repository roots
- spec approved on the receiving side -> `/kn-flow @doc/<spec-path>`

## Checklist

- [ ] Mode chosen and not blended with the other direction
- [ ] Identity block complete, with `replies-to` set when answering a brief
- [ ] No `@doc/`, `@task-`, or `@decision/` refs anywhere in the document
- [ ] File references carry a repository prefix and a full path
- [ ] Every required section present, in order
- [ ] Assumptions labeled, for a brief; divergences reported, for a contract
- [ ] Repository copy and mirror both written, with `source.json`
- [ ] Version incremented rather than overwriting a published handoff

## Abort Conditions

- The requested handoff cannot be located in the repository copy, the mirror, or an explicit path
- A `contract` is requested for work that is not actually implemented and verified
- Writing would overwrite a published version instead of creating a new one
- The source material is too thin to write the mode's required sections without inventing facts
