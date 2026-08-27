---
name: kn-decision
description: Use when creating, triaging, promoting, or superseding a System Decision - the durable project guidance other skills enforce
---

# Managing System Decisions

**Announce:** "Using kn-decision for [decision or inbox]."

**Core principle:** DRAFT FREELY -> RESOLVE DELIBERATELY -> NEVER PROMOTE WITHOUT A HUMAN.

A System Decision is durable project guidance. Once accepted it binds every later task, and other skills validate against it. That asymmetry sets the rule for this skill: reading and drafting are cheap and reversible, so they run without asking; promoting or retiring guidance is neither, so it always stops for a person.

## Inputs

- A Decision ID, or a pending draft to triage, or a new durable constraint to record
- The originating work: task ID, spec path, commit, or other readable source
- Optional: a specific action when the user already knows what they want

## Preflight

- Read the linked spec's canonical `Locked Decisions` section when the work references one. Spec Decisions are scoped execution rules; do not copy them into the Decision ledger.
- Retrieve relevant current Decisions with bounded filters before proposing anything new, so a duplicate is caught before it is drafted.
- Memory category `decision` is legacy and closed to new writes. Redirect any request to record a decision as Memory into this flow instead.

## What This Skill Owns

Eight lifecycle actions:

| Action | Purpose | Gate |
|--------|---------|------|
| `create` | Record a new Decision; always lands as `draft` | free |
| `list` | Enumerate Decisions, filtered by status or tag | free |
| `get` | Read one Decision in full | free |
| `link` | Attach tasks, docs, or sources as provenance | free |
| `review_inbox` | List drafts awaiting resolution | free |
| `resolve` | Settle a draft against existing guidance | per resolution |
| `accept` | Promote `draft` -> `accepted` | **stop for human** |
| `supersede` | Retire a Decision in favour of a replacement | **stop for human** |

Statuses: `draft`, `accepted`, `superseded`, `rejected`, `archived`. The eight actions above reach the first four. `archived` is reachable only through legacy migration, which this skill does not own, so treat an archived Decision as read-only here.

## What This Skill Does Not Own

Legacy Decision Memory migration — `migration_preview`, `migration_apply`, `migration_rollback` — is out of scope. It is a one-time administrative operation with its own rollback path and its own set of resolutions, and mixing it into everyday lifecycle work makes both harder to follow.

If the user asks to migrate legacy Decision Memory entries, say the operation exists on the `decision` tool but sits outside this skill, and let them drive it deliberately rather than performing it here.

## Where Decisions Come From

Two creation paths, deliberately kept separate:

- **In-flow.** While implementing a task, `kn-implement` records a candidate at its System Decision Impact checkpoint. That path stays as it is. Do not duplicate a candidate that a task already created.
- **Standalone.** A durable constraint often surfaces with no task in flight, during spec work or review. That is the path this skill adds.

Either way the result is a `draft`. Creation never promotes.

## Step 1: Establish Position

Start from what already exists, not from a blank draft.

```json
mcp_knowns_decision({ "action": "review_inbox" })
mcp_knowns_decision({ "action": "list", "status": "accepted" })
```

Read any Decision that looks related before proposing a new one:

```json
mcp_knowns_decision({ "action": "get", "id": "<decision-id>" })
```

A new draft that restates current guidance is noise. A new draft that contradicts it is a conflict, and conflicts are resolved, not stacked.

## Step 2: Draft or Triage

To record a new Decision:

```json
mcp_knowns_decision({ "action": "create",
  "title": "<short imperative title>",
  "context": "<what forced this decision>",
  "decision": "<what was decided, stated plainly>",
  "alternatives": "<what was rejected and why>",
  "consequences": "<what this makes true, breaks, or supersedes>",
  "relatedTasks": ["<task-id>"],
  "relatedDocs": ["<spec-or-doc-path>"],
  "sources": ["<commit, file, or other readable evidence>"]
})
```

Provenance is not optional. A Decision with no linked task, doc, or source cannot be verified later, and an unverifiable Decision cannot be accepted.

To attach provenance to an existing Decision:

```json
mcp_knowns_decision({ "action": "link", "id": "<decision-id>",
  "relatedTasks": ["<task-id>"], "sources": ["<evidence>"] })
```

## Step 3: Resolve

`resolve` decides what happens to a draft relative to existing guidance. Three of the five resolutions settle it; two leave it pending on purpose.

| Resolution | Meaning | Gate |
|------------|---------|------|
| `create_draft` | Keep it as a draft for now | free |
| `link_as_related` | Relate it to an existing Decision without changing status | free |
| `accept_new` | Promote this draft to current guidance | **stop for human** |
| `supersede_existing` | Promote it and retire the Decision it replaces | **stop for human** |
| `reject_new` | Reject the draft outright | **stop for human** |

```json
mcp_knowns_decision({ "action": "resolve",
  "candidateId": "<draft-id>",
  "resolution": "<one of the five>",
  "targetId": "<existing decision id, when the resolution needs one>"
})
```

## Step 4: The Human Gate

Five operations change what binds future work: `accept`, `supersede`, and the `accept_new`, `supersede_existing`, `reject_new` resolutions.

Before any of them, stop and present:

- the Decision title and what it would make binding
- the evidence linked to it, and any evidence that is missing
- what it supersedes or rejects, if anything
- what changes for future work if it is accepted

Then wait for explicit confirmation. Do not infer approval from earlier instructions to "run the flow" or "finish the task" — those authorize the work, not the promotion of project guidance.

```json
mcp_knowns_decision({ "action": "accept", "id": "<decision-id>" })
mcp_knowns_decision({ "action": "supersede", "oldId": "<retired-id>", "newId": "<replacement-id>" })
```

`accept` also takes a `supersedes` array to retire current Decisions atomically on promotion. That is still one gated operation, and the retirements must be named in the confirmation, not discovered afterwards.

An unresolved draft is a safe resting state. A prematurely accepted Decision is not, because every later task validates against it.

## Shared Output Contract

All built-in skills in scope must end with the same user-facing information order: `kn-init`, `kn-spec`, `kn-flow`, `kn-plan`, `kn-research`, `kn-handoff`, `kn-implement`, `kn-decision`, `kn-verify`, `kn-doc`, `kn-template`, `kn-extract`, and `kn-commit`.

Required order for the final user-facing response:

1. Goal/result - state what was drafted, resolved, promoted, retired, or left pending.
2. Key details - include the most important supporting context, provenance, conflicts, or gaps.
3. Next action - recommend a concrete follow-up command only when a natural handoff exists.

Keep this concise for CLI use. Decision-specific content may extend the key-details section, but must not replace or reorder the shared structure.

Do not manage platform-synced skill copies; this source defines the built-in workflow contract.

For `kn-decision`, the key details should cover:

- the Decision ID and its resulting status
- linked provenance, and any provenance still missing
- conflicts with current guidance, stated plainly
- what is still waiting on a human, if anything

When a draft is left pending because confirmation was not given, say so directly rather than reporting the work as complete.

## Related Skills

- `/kn-verify` - reports missing or malformed System Decision Impact markers that lead here
- `/kn-review` - raises a finding when a draft is treated as current before resolution
- `/kn-implement <id>` - records the in-flow candidate this skill later resolves
- `/kn-spec` - keeps scoped Spec Decisions in a spec's `Locked Decisions`, which never belong in this ledger
- `/kn-extract` - captures reusable patterns and learnings that are not durable Decisions

## Checklist

- [ ] Existing current Decisions retrieved before drafting anything new
- [ ] Draft carries linked task, doc, or source provenance
- [ ] Conflicts with current guidance surfaced, not stacked
- [ ] Every gated operation stopped for explicit human confirmation
- [ ] Retirements named before an atomic accept, not after
- [ ] Spec Locked Decisions left in the spec, not copied into the ledger
- [ ] No Memory of category `decision` created
- [ ] Pending drafts reported as pending

## Red Flags

- Accepting or superseding without explicit confirmation
- Treating "run the flow" as approval to promote guidance
- Drafting a Decision that restates or contradicts current guidance without saying so
- Creating a Decision with no readable evidence
- Duplicating a candidate a task already recorded
- Copying Spec Locked Decisions into the System Decision ledger
- Creating legacy Decision Memory instead of a Decision
- Performing legacy migration from this skill
- Reporting a pending draft as if it were settled
