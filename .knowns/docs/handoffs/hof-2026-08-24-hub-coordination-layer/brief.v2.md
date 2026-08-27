---
id: doc-8f31c2a6b47e5d90a1c8e3f7b25d6104
title: 'Handoff Brief v2: Hub Coordination Layer'
description: 'Revision of brief v1, rewritten after surveying the archived Hub implementation. Narrows to five gaps between what was already built and the agreed coordination model.'
createdAt: '2026-08-24T06:40:00.000Z'
updatedAt: '2026-08-24T06:40:00.000Z'
tags:
  - handoff
  - hub
  - cross-repo
---

# Handoff Brief: Hub Coordination Layer

```text
handoff-id:   hof-2026-08-24-hub-coordination-layer
direction:    cli->hub
version:      2
supersedes:   hof-2026-08-24-hub-coordination-layer brief v1
replies-to:   (none)
source-repo:  knowns @ 0fdf1a8, branch develop (git@github.com:knowns-dev/knowns.git)
target-repo:  knowns-hub
prior-art:    knowns-hub-legacy @ 410aab4, tag pre-reset-2026-08-24
generated:    2026-08-24
```

This document is a `brief`. It carries questions and unconfirmed assumptions from the
CLI side and has no authority over the Hub implementation. Items marked `PROPOSED` or
`ASSUMED` are for the Hub side to decide, reject, or replace.

## Why version 2 exists

Version 1 was written without reading the previous Hub implementation. It proposed
several things that already existed, and it was wrong about how far the work had gone.

A survey of `knowns-hub-legacy` afterwards found roughly 45,000 lines of working
software on a clean hexagonal architecture, whose domain model already matches the
agreed direction. The direction had not drifted. What was missing was narrower and more
specific than v1 implied.

This revision replaces the proposal with a gap list. Sections 3.1, 5.2 and 5.3 of v1 are
withdrawn: they described objects that exist.

## 1. The agreed model, in one paragraph

Hub owns coordination. Repositories own code and their own knowledge. Local `.knowns/`
holds repository knowledge and changes when code changes; Hub holds business knowledge
and coordination state and changes when the business changes. A business rule change
must not require a commit to seven repositories. Full statement lives in
`knowns-hub/PRODUCT.md` and `knowns-hub/.knowns/docs/specs/hub-v1-backend-first-coordination-scope.md`.

Nothing in that paragraph is new. It was written on 2026-07-09 and it still holds.

## 2. Prior art: what the archived implementation already provides

Read before designing. These are load-bearing and worth carrying forward rather than
re-deriving. Paths are relative to `knowns-hub-legacy` at tag `pre-reset-2026-08-24`.

| Area | Location | Size | What it gives |
|---|---|---|---|
| Coordination domain | `apps/api/src/modules/coordination/` | 18 files, ~4,400 lines | `REPOSITORY`, `WORKSTREAM`, `TASK`, `HANDOFF`; repository participants; workstream assignment; `attention-query.service.ts` answering "what needs my attention" |
| Contracts | `apps/api/src/modules/contracts/` | 12 files, ~1,700 lines | `CreateContract`, `PublishContract`, `AcceptContractVersion`, `RetireContract`, `CONTRACT_SCHEMA_TYPES`, plus an MCP action surface |
| Machine actors | `apps/api/src/modules/machine-actors/` | 8 files, ~1,200 lines | Actor kinds `agent_session` and `api_key`, with a token codec port and a Node implementation |
| Permissions | `apps/api/src/modules/permissions/` | 8 files, ~860 lines | Workspace authorization model, transactional owner writer |
| Knowledge | `apps/api/src/modules/knowledge/` | 35 files, ~7,500 lines | Document processing pipeline, `document-vector-search.port.ts`, `DocumentClassification`, worker and reconciliation modules |
| Governance | `apps/api/src/modules/runtime-governance/` | 13 files, ~2,600 lines | Guarded operations, jobs, events, operational status |
| Plumbing | `apps/api/src/` | 11 controllers incl. `mcp.controller.ts`, 85 test files, `openapi:generate` | Hexagonal layering (`domain` / `application/ports` / `application/services` / `infrastructure` / `presentation` with both `http` and `mcp`) |

`ASSUMED, not verified:` the substrate items above are direction-neutral. Workspace
isolation, invitations, permissions, machine tokens, persistence patterns, and the MCP
presentation shape look the same under any version of this product. Rewriting
authorization from scratch is a way to introduce new security defects, not a way to
change direction.

`ASSUMED, not verified:` the `knowledge` module is the item most affected by the agreed
model. It implements an ingest-and-reconcile pipeline. The agreed model says Hub is the
home for knowledge that has no repository plus a shelf for what was deliberately
published, and never a mirror of `.knowns/docs/`. Whether that makes the module a good
starting point or the wrong shape is a Hub decision, and it is question 5 below.

## 3. The five gaps

Each gap states what exists, what is missing, and why it matters. Nothing here proposes
a schema.

### Gap 1: there is no delivery channel

**Exists:** an MCP controller and an HTTP API. Coordination state is queryable, and
`attention-query.service.ts` looks like the query layer that would feed a notification.

**Missing:** anything an agent receives without asking. A grep for `hook` across
`apps/api/src` matches only `bootstrap.ts` and a knowledge service.

**Why it matters:** the v1 scope says agents coordinate *through* Hub API/MCP. That is
pull, and it depends on an agent choosing to ask at the right moment. Every product in
this space is pull. The one capability nobody else has is push.

Claude Code supports an `http` hook handler natively, so Hub can be the endpoint with no
local shim:

```json
{ "type": "http",
  "url": "https://hub.example.dev/hooks/inbox",
  "headers": { "Authorization": "Bearer $KNOWNS_HUB_TOKEN" },
  "allowedEnvVars": ["KNOWNS_HUB_TOKEN"],
  "timeout": 5 }
```

The response shape is fixed by Claude Code:
`{ "hookSpecificOutput": { "hookEventName": "...", "additionalContext": "..." } }`.

`ASSUMED, not verified:` three deterministic queries feed one response - tasks assigned
to the caller, linked Hub docs that moved to a newer version, and contracts the caller
consumes that are now stale.

**Verified constraint:** `additionalContext` is documented for several events but has
open defects on others (`anthropics/claude-code` issues #19432, #18534, #24788, #20062,
covering PreToolUse, PostToolUse, MCP tool calls, and the VSCode extension). The
documented reliable path is `SessionStart` and `UserPromptSubmit`. `TeammateIdle` is
attractive as a "pull the next task when an agent goes idle" trigger but should be
treated as unverified until tested.

`ASSUMED, not verified:` the endpoint must fail open. Every prompt from every developer
calls it. A slow or absent Hub must cost nothing beyond the missing notification.

### Gap 2: the handoff lifecycle models delegation, not publication

**Exists**, in `apps/api/src/modules/coordination/domain/coordination.ts`:

```ts
HANDOFF_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'completed', 'cancelled']
HANDOFF_ARTIFACT_TYPES = ['document', 'url', 'repository_path']
```

**Missing:** a state that lets a consumer start before the producer has finished. The
statuses above describe assigning work to someone who accepts or rejects it. What the
coordination model needs is a settled interface published early:

| State | Meaning | Consumer can |
|---|---|---|
| `agreed` | Settled by decision, not yet built | Start now, against mocks |
| `implemented` | Coded and verified | Verify against the real API |

**Why it matters:** without it the team is serial by construction. With it, three days of
waiting become three days of parallel work. This is the single largest behavioural change
in the whole model.

`PROPOSED, hub decides:` this may belong on `Contract Version` rather than on
`HandoffStatus`, since publication and delegation are genuinely different axes and the
`contracts` module already has `PublishContract` and `AcceptContractVersion`.

`ASSUMED, not verified:` publishing must not require the source branch to be pushed or
merged. A contract at `agreed` may reference a commit that exists only on an unpushed
local branch. How Hub represents that is a Hub decision, but it must not reject the
publish.

`ASSUMED, not verified:` `agreed` should carry real example payloads rather than prose.
`HANDOFF_ARTIFACT_TYPES` today is `document | url | repository_path`, none of which is a
machine-readable contract body. Examples are what consumers build mocks from and what
later verification diffs against.

### Gap 3: staleness is not per consumer

**Exists:** `CreateContract`, `PublishContract`, `AcceptContractVersion`, `RetireContract`.
Acceptance of a specific version is modelled.

**Missing:** the derived view. A grep for `consumer`, `producer`, or `stale` across
`apps/api/src/modules/contracts/domain/contracts.ts` returns nothing.

**Why it matters:** one producer commonly has several consumers - a web app and a mobile
app against one API. The row that prevents a broken integration is this one:

```
hof-2026-08-24-order-refund  v2 implemented
  knowns-web     consumed v2   updated 14 minutes ago
  knowns-mobile  stale    v1   updated 3 days ago
```

`ASSUMED, not verified:` if `AcceptContractVersion` already records which participant
accepted which version, then `stale` is a query over existing data rather than new
storage, and this gap is smaller than it looks. The CLI side could not determine that
from the domain file alone.

### Gap 4: reading is not restricted by actor type

**Exists:** `machine-actors` distinguishes `agent_session` from `api_key`, with a token
codec. `permissions` has a workspace authorization model. `knowledge` has
`DocumentClassification`.

**Missing:** a rule that says a document may be read by a person and not by a model.

**Why it matters:** some business material can be shown to a teammate but must never
enter a model's context, because that means sending it to a model provider. Client
contract terms, personal data, legal text, compensation, anything under a strict NDA.
Today a team either keeps that material out of their tooling entirely or accepts that any
agent may pick it up.

`PROPOSED, hub decides:` reading is constrained along four independent axes.

| Axis | Values | Question |
|---|---|---|
| `audience` | `workspace` / `repos[]` / `members[]` / `owner` | Which people may see it |
| `actor_type` | `human` / `agent` | May a model read it |
| `content_level` | `full` / `metadata` | The document, or only that it exists |
| `origin` | `hub` / `published` / `referenced` | Who owns the truth for it |

| `ai_access` | Agent caller receives | Human caller receives |
|---|---|---|
| `allow` | Full content | Full content |
| `metadata_only` | Title, owner, tags, restriction marker | Full content |
| `deny` | Nothing; the object does not appear | Full content |

The gap between `metadata_only` and `deny` is deliberate. Under `metadata_only` an agent
can tell its developer "there is a document about refund approval thresholds, owned by
@be-dev, that I may not read" - useful, and no leak. Under `deny` the agent cannot learn
it exists.

`ASSUMED, not verified:` enforcement is server-side and derived from the token kind,
never from a client-supplied field, because a client that declares its own actor type
can lie. The existing `agent_session` / `api_key` distinction may already be the right
hook for this. Every agent-facing path is subject to it: `/hooks/inbox`, MCP `search`,
MCP `retrieve`. The web UI is the only human path.

**Stated limitation, to be documented rather than implied away:** Hub enforces the
channel, not the person. Someone who reads a `deny` document in the web UI and pastes it
into their agent has defeated the control. This is a guardrail against accidental
ingestion and a statement about what the system does on its own, not a technical
guarantee.

`ASSUMED, not verified:` the complementary write axis - what an AI session may update,
archive, delete, publish, or overwrite - is researched at
`knowns/.knowns/docs/research/ai-permission-model.md`, which observes that Knowns today
has distributed safeguards rather than one policy model. Read and write should probably
share one capability layer.

### Gap 5: task mirrors store content by default

**Exists**, in `apps/api/src/modules/coordination/domain/coordination.ts`:

```ts
SourceMirroredTask = { sourceTaskId, title, summary?, status, priority?,
                       metadata?, sourceTaskUpdatedAt? }
NormalizedSourceMirroredTask = SourceMirroredTask + payloadHash
```

**Missing:** a tier below that. The mirror imports titles and summaries.

**Why it matters:** what a team needs from a mirror is rhythm and divergence, not
content:

```
knowns-web     2 tasks active   consumed v2   updated 14 minutes ago
knowns-mobile  1 task active    stale v1      updated 3 days ago
```

`PROPOSED, hub decides:` two tiers, defaulting to the lower one.

| Tier | Hub stores | Team sees | Owner sees |
|---|---|---|---|
| `presence` (default) | Count of active local tasks, state, linked artifact id, last update | Yes | Yes |
| `full` (opt-in) | Plus plan, acceptance criteria, notes, file references | No | Yes |

`ASSUMED, not verified:` titles are not a safe middle tier. "Fix token refresh in
useRefund hook" already discloses module structure. The current mirror sits between
`presence` and `full`, closer to the agreed model than full mirroring would be, but above
the proposed default.

`ASSUMED, not verified:` the default decides everything, because almost nobody changes a
setting. If the default stores content, the claim that implementation detail stays on the
developer's machine is true only on paper.

`ASSUMED, not verified:` the honest reason to offer `full` is continuity for one person
across their own machines and across context compaction, not hiding work from teammates,
and it should be documented that way.

## 4. Retrieval: one constraint, narrower than "no RAG"

Semantic search on Hub is wanted. Cross-repository discovery is something no local store
can do, and `document-vector-search.port.ts` already abstracts it behind a port, so the
adapter is a free choice.

The constraint is only this: **the inbox path must never rank by relevance.**

| | Deterministic lookup | Semantic retrieval |
|---|---|---|
| Serves | Inbox, handoff, contract, version, assignment | Cross-repository discovery |
| Called by | The hook, automatically, every prompt | An agent, deliberately |
| When wrong | A consumer builds on a stale contract and nobody notices | A weaker result; ask again |

If the hook uses similarity to decide what to inject, a contract revision will eventually
fall outside the top results and no one will know it was missed. Silent misses are the
expensive failure in coordination work.

`ASSUMED, not verified:` because coordination data is small - on the order of ten to
twenty handoffs a month and a few thousand rows a year for a ten-person team - the index
does not need a dedicated vector service. Given the port abstraction, `pgvector` in the
postgres instance that already exists would remove one service, one volume, one thing to
back up, and one thing to migrate. If the Hub side has volume data suggesting otherwise,
that changes the calculation.

## 5. Questions for the Hub side

Narrowed from nine in v1 to six, ordered by how much the answer changes the work.

1. **Does `AcceptContractVersion` already record which participant accepted which
   version?** If yes, Gap 3 is a read model over existing data. If no, it is structural
   and should be settled before anything is built on top.

2. **Does `ai_access` fit the existing permission mechanism**, or does actor-type
   enforcement cut across the authorization model badly enough to need a different
   design? This needs answering before the capability is promised to anyone.

3. **Should the publication lifecycle live on `Contract Version` rather than on
   `HandoffStatus`?** The CLI side suspects yes, since the `contracts` module already has
   publish and accept, and delegation and publication are different axes.

4. **Is publish-before-merge acceptable in the Hub's model of a repository?**

5. **What happens to the `knowledge` module?** It is the largest single module and the
   one furthest from the agreed model. Keeping it, narrowing it to a Hub-owned document
   store, or removing it are all defensible; the CLI side has no view that outweighs the
   Hub side's knowledge of that code.

6. **What is the deployment target?** For a self-hosted product whose realistic user is a
   three-person team, deployment weight is likely the main adoption constraint. If the
   agreed model holds, asset storage has no remaining purpose and the vector service is
   replaceable. The CLI side may be missing a requirement that justifies both.

## 6. Risks

| Risk | Why it matters |
|---|---|
| The producer does not publish early | `agreed` asks a developer to commit to a contract before writing the code. If team habit does not change, none of the parallelism is realised. Largest risk, and not technical. |
| Mock drift | A consumer builds against `agreed` for three days and the contract moves to `v2`. Versioning and diffs contain it, but rework is the price of parallel work. |
| Hub latency on every prompt | The hook runs on every prompt from every developer. Fail open, short timeout, no exceptions. |
| Hub becomes a document dump | Every wiki ends this way. Hub holds *why* and *what*; local holds *how*. The first "how to deploy service X" document is where the boundary starts eroding. |
| Two indexes confuse agents | The CLI indexes the local store, Hub indexes cross-repo artifacts. Without an explicit routing rule in the skills, agents will query both or query the wrong one. |
| Version skew between repositories | Two repositories, two release cycles, one maintainer. `GET /version` and a written compatibility rule from the second commit, not after the first mismatch. |

Worth noting without irony: `knowns` and `knowns-hub` are exactly the two-repository
split this product exists to serve. Friction felt using `kn-handoff` between them is
friction a customer would feel.

## 7. Acceptance criteria from the CLI side

1. A handoff version publishes from machine A and reads from machine B **without the
   source branch having been pushed or merged**. Verified by publishing from a dirty
   local branch and pulling on a second machine.

2. The inbox returns assignments, stale contracts, and doc version changes **by
   deterministic query, with no relevance ranking anywhere in the path**. Verified by
   publishing twenty unrelated handoffs and confirming the one relevant stale contract is
   always returned.

3. The hook endpoint returns valid `hookSpecificOutput.additionalContext` and **fails
   open**. Verified by stopping Hub and confirming a developer's session is unaffected
   apart from the missing notification.

4. For one artifact with two consumer repositories, the response distinguishes a consumer
   on `v2` from one still on `v1`. Verified by the `stale` row appearing for exactly one.

5. A document with `ai_access: deny` **does not appear** in any agent-facing response,
   including the hook endpoint, MCP `search`, and MCP `retrieve`, while remaining readable
   in the web UI by a permitted human. Verified by querying with an agent token and a
   session token and diffing.

6. Actor type is derived from the token, **not from a request header or body field**.
   Verified by attempting a `deny` read with an agent token carrying a forged human
   actor claim and confirming refusal.

7. Local task state propagates up and **nothing propagates down**. Verified by editing a
   Hub task and confirming the local store is untouched.

8. `GET /version` exists and a documented compatibility rule is followed, so a CLI meeting
   an incompatible Hub reports it clearly rather than failing opaquely.

## Open questions carried

All six in section 5. The three that most change the shape of the work: whether
per-participant version acceptance already exists (5.1), whether `ai_access` fits the
permission model (5.2), and what happens to `knowledge` (5.5).

## What this brief deliberately does not do

It proposes no schema, no migration, no framework, and no storage engine. Where it names
a technology it is to expose a constraint the CLI side believes exists, not to make the
choice. It also does not recommend discarding the archived implementation: most of what
it contains is direction-neutral, and the parts that are not are named in section 3.
