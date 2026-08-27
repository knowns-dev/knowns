---
id: doc-2995e51bae00ad2ac9b04fbf8deea83e
title: 'Handoff Brief v1: Hub Coordination Layer'
description: 'Cross-repo handoff brief from knowns (CLI) to knowns-hub. Carries the two-entity model, handoff transport, hook inbox, and the four-axis permission model including ai_access.'
createdAt: '2026-08-24T06:02:22.000Z'
updatedAt: '2026-08-24T06:02:22.000Z'
tags:
  - handoff
  - hub
  - cross-repo
---

# Handoff Brief: Hub Coordination Layer

```text
handoff-id:   hof-2026-08-24-hub-coordination-layer
direction:    cli->hub
version:      1
replies-to:   (none)
source-repo:  knowns @ 0fdf1a8, branch develop (git@github.com:knowns-dev/knowns.git)
target-repo:  knowns-hub
generated:    2026-08-24
```

This document is a `brief`. It carries questions and unconfirmed assumptions from the
CLI side. It has no authority over the Hub implementation. Everything marked
`PROPOSED` or `ASSUMED` is for the Hub side to decide, reject, or replace.

---

## 1. Feature summary

Knowns today is a single-repository memory and workflow layer. A feature that spans
two repositories has no artifact to carry it: the receiving side opens a fresh
session with no shared store and re-derives the API shape from memory. The
`kn-handoff` skill in this repository writes that artifact, but it has no transport
between machines and no signal that tells the receiving side an artifact exists.

Knowns Hub is the layer that closes both gaps. It is a coordination and team-knowledge
layer, not a second document store and not a project management board.

**Two entities, two clocks.**

| | Local (`.knowns/` in each repo) | Hub |
|---|---|---|
| Holds | Repository knowledge: how this codebase works | Team knowledge: what the business needs and why |
| Changes when | Code changes | Business changes |
| Lifetime | Lifetime of the repository | Lifetime of the company |
| Written by | Developers and their agents | Product owners, leads, whoever owns the business rules |
| Audience | The owning developer and their agent | The team, across repositories |

A business rule change must not require a commit to seven repositories. That is why
business knowledge has no home in git, and why Hub exists as a separate entity rather
than as a mirror of local stores.

**Primary user flow the Hub must support.**

```
Business changes
  -> a Hub doc records what changed and why
  -> a Hub task is created and assigned to one or more members, each bound to a repo
  -> a hook injects that assignment into each member's agent context automatically
  -> each member creates a local task in their own repo to execute it their own way
  -> the producing side publishes a contract; consuming sides work in parallel
  -> local task completion propagates state back up to the Hub task
```

**Non-goals, stated explicitly so they are not inferred later.**

- Hub is not a Kanban board. A board may exist as a view, but it is not the product.
- Hub does not ingest or mirror `.knowns/docs/` from repositories. Content arrives
  only by explicit publish.
- Hub does not own repository knowledge, task execution detail, source code, or assets.
- Hub does not orchestrate agents. Developers keep running their own agents exactly
  as they do today. Hub only delivers what is waiting for them.

---

## 2. Source-side summary: what already exists in `knowns`

This section describes the CLI side as it stands, so the Hub side can see what it is
integrating with rather than guessing.

**Handoff artifact.** `knowns/internal/instructions/skills/kn-handoff/SKILL.md`
defines the artifact this Hub must transport. Relevant properties, all already settled
on the CLI side:

- `handoff-id` is the only join key between two repositories. Paths differ per machine
  and per checkout, so a handoff is always referenced by id and version.
- Two modes that are different documents: `brief` (questions and unconfirmed
  assumptions, no authority) and `contract` (settled, implemented fact, authoritative
  for integration).
- Published versions are immutable. A revision becomes `v<n+1>` so the receiving side
  can diff and see what broke.
- Lifecycle states today: `open` (brief published), `answered` (contract returned),
  `consumed` (receiving side has produced a spec from it).
- Cross-repo reference rule: a handoff document must contain no `@doc/`, `@task-`, or
  `@decision/` refs, because they resolve against a store the receiving repo does not
  have. File references carry a repository prefix and a full path.
- Storage is two copies: the repository copy at
  `<repo>/.knowns/docs/handoffs/<handoff-id>/<mode>.v<n>.md`, and a mirror at
  `~/.knowns/handoffs/<handoff-id>/v<n>/` with a `source.json` recording repository
  name, git remote, branch, commit sha, mode, version, and content hash.

**The transport gap.** The mirror is a home directory on one machine. It solves
"two repos checked out on my laptop". It does nothing when the other side is a
different person on a different machine. The only remaining transport today is git,
which means handoff latency equals commit plus push plus review plus merge plus pull.

**Runtime hook.** The CLI already registers exactly one hook in the user's Claude Code
settings:

```json
"UserPromptSubmit": [{
  "hooks": [{
    "type": "command",
    "command": "knowns runtime-memory hook --runtime claude-code --event user-prompt-submit"
  }]
}]
```

It fires on every prompt and injects recalled memory into the agent's context. This is
the delivery channel the Hub should use. The mechanism is proven and already shipping.

**Existing CLI surface worth knowing about.**

- `knowns decision inbox` already exists (`knowns/internal/cli/decision.go:41`), listing
  unresolved decision candidates. A handoff inbox follows an established shape rather
  than introducing a new concept.
- `knowns/internal/tunnel/cloudflared` is already vendored. A self-hosted Hub can be
  reachable without a VPS, a domain, or an open port.
- `knowns/internal/server/` already provides HTTP, SSE, and auth for a local UI.
- `knowns/internal/search/` (roughly 15k lines) and `knowns/internal/qdrantruntime/`
  provide semantic search over the local store. Repository-scoped search is solved on
  the CLI side and should not be rebuilt in Hub.
- `knowns/internal/codegen/` is a Handlebars template engine, currently used for
  `knowns template`. It is a plausible substrate for generating typed clients from a
  machine-readable contract, but that is a later step.

---

## 3. Hub needs and assumptions

Everything in this section is labeled. Nothing here is a requirement on the Hub schema
or implementation.

### 3.1 Objects the CLI expects to exist

`PROPOSED, hub decides:` the Hub needs roughly these objects. Names are indicative.

| Object | Why the CLI needs it |
|---|---|
| `workspace` | Isolation boundary. One agency serving several clients must not mix them. |
| `member` | Identity behind a token. Assignment and permission both key off this. |
| `repo` | A registered repository. Handoffs and tasks bind to repos, not to checkouts. |
| `handoff` | Carries `handoff-id`, mode, version chain, state, producer repo, consumer repos. |
| `contract` | The `contract` mode payload plus its lifecycle state. May be the same object as `handoff`. |
| `hub_task` | The unit of commitment. Assigned to members, each bound to a repo. |
| `hub_doc` | Business knowledge. Born on Hub or explicitly published from a repo. |
| `link` | Local task to Hub task, local doc to Hub doc, with the source version recorded. |

`ASSUMED, not verified:` the volume is small. For a ten-person team we expect on the
order of ten to twenty handoffs per month and a few thousand rows per year in total.
If that assumption holds, the storage engine is not a constraint and the Hub should
choose whatever is simplest to operate. If the Hub side has data suggesting otherwise,
that changes the calculation and we would like to know.

### 3.2 Lifecycle change the CLI needs

`PROPOSED, hub decides:` the current handoff lifecycle serializes the team. The
`contract` mode rule says "describe only what is implemented and verified", so a
consumer cannot start until the producer has finished. That guarantees sequential work.

We would like one additional state between `open` and `answered`:

| State | Meaning | What the consuming side can do |
|---|---|---|
| `open` | Brief published, waiting | Nothing yet |
| `agreed` | **Contract settled by decision, not yet implemented** | **Start immediately, against mocks** |
| `implemented` | Coded and verified | Verify against the real API |
| `consumed` | Receiving side has produced a spec from it | Done with the handoff |

This is the change that turns three days of waiting into three days of parallel work.
It is also the change with the largest behavioural risk: a contract at `agreed` can
still be wrong, and consumers will have built against it.

`ASSUMED, not verified:` the mitigation is that `agreed` requires real example payloads
rather than prose, and that any revision becomes `v<n+1>` with a diff surfaced to every
consumer. The `kn-handoff` contract mode already requires worked examples, so the
material exists. Whether Hub should enforce that requirement or merely record it is a
Hub decision.

### 3.3 Fan-out: one producer, several consumers

The current identity block is one-to-one:

```text
direction:    fe->be
source-repo:  knowns-web @ 3f9a1c2
target-repo:  knowns-api
```

The common real case is one backend and two consumers, a web app and a mobile app.
`PROPOSED, hub decides:` `target-repo` becomes a list, and state moves from belonging
to the handoff to belonging to each `(handoff, consumer)` pair:

```text
hof-2026-08-24-order-refund  v2  implemented
  knowns-web      consumed  (v2)
  knowns-mobile   stale     (still on v1)
```

That `stale` row is the signal that prevents a broken integration before it happens.
It is the single most valuable row in the system and we would like it to exist early.

### 3.4 State propagation is one-way

`PROPOSED, hub decides:` local is the source of truth for progress. Hub is the source
of truth for commitment. Local task completion propagates up. Hub never writes down
into a local store.

The reason is not philosophical. Two-way sync requires conflict resolution, and
conflict resolution is the hardest part of any system of this shape. A one-way flow
removes the need for it entirely. We would rather lose a feature than gain a merge
algorithm.

### 3.5 Retrieval has two modes and they must not be merged

This is the constraint the CLI side feels most strongly about.

| | Deterministic lookup | Semantic retrieval |
|---|---|---|
| Used for | Inbox, handoff, contract, version, assignment | Discovery across repositories |
| How | `WHERE repo = ? AND member = ? AND stale = true` | Vector plus keyword |
| Called by | The hook, automatically, on every prompt | An agent, deliberately, when it needs to explore |
| When wrong | A consumer builds on a stale contract and nobody notices | A weaker result, ask again |

Semantic search on Hub is wanted and useful. Cross-repository discovery is something
no local store can do, and it is a legitimate reason for Hub to hold an index.

The constraint is narrower than "no RAG": **the inbox path must never rank by
relevance.** If the hook uses similarity to decide what to inject, a contract revision
will eventually fall outside the top results and no one will know it was missed. Silent
misses are the expensive failure in coordination work.

### 3.6 What Hub indexes, and what it must not

`PROPOSED, hub decides:`

| | Indexed on Hub | Reason |
|---|---|---|
| Handoffs and contracts | Yes | Cross-repo by design. The skill already requires them to be readable in a repo with none of the source repo's context. |
| Published decisions | Yes | Deliberately shared |
| Hub tasks, workstreams, activity | Yes | Native Hub data |
| Business docs born on Hub | Yes | Hub owns them |
| `.knowns/docs/` from repositories | **No, unless explicitly published** | Lives in git, already indexed by the CLI. Mirroring creates a second copy and permanent drift. |
| Local task plan, notes, file references | **No** | See section 5.3 |
| Source code, binary assets | **No** | Lives in git |

The distinction that matters: **Hub is the home for knowledge that has no repository,
and a publisher's shelf for knowledge that was deliberately shared. It is never a
mirror.** `publish`, never `sync`. One direction, one document at a time, chosen by a
person.

---

## 4. Suggested API contract

`PROPOSED, hub decides everything in this section`, including paths, shapes, transport,
and whether these are separate endpoints at all. This exists to expose what the CLI
needs, not to specify the Hub.

### 4.1 The hook endpoint

Claude Code supports an `http` hook handler type natively, with `url`, `headers`
(with `$VAR` interpolation), `allowedEnvVars`, and `timeout`. That means Hub can be
the hook endpoint directly, with no local shim:

```json
"UserPromptSubmit": [{
  "hooks": [{
    "type": "http",
    "url": "https://hub.example.dev/hooks/inbox",
    "headers": { "Authorization": "Bearer $KNOWNS_HUB_TOKEN" },
    "allowedEnvVars": ["KNOWNS_HUB_TOKEN"],
    "timeout": 5
  }]
}]
```

The response shape is fixed by Claude Code, not by us:

```json
{ "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "..." } }
```

`ASSUMED, not verified:` three queries feed one response.

| Signal | Query shape |
|---|---|
| Task assigned to me | `assignee = me AND state != done` |
| Business doc I linked went to a new version | `linked_by = me AND hub_version > my_version` |
| Contract I consume is stale | `consumer = me AND stale = true` |

`ASSUMED, not verified:` the hook must fail open. Every prompt from every developer
calls this endpoint. If Hub is slow or down, the developer must keep working with no
degradation beyond losing the notification. A short timeout and an empty response on
error, never a blocking failure.

**Verified constraint worth carrying:** `additionalContext` is documented for several
events but there are open bugs where it is not injected (`anthropics/claude-code`
issues #19432, #18534, #24788, #20062, covering PreToolUse, PostToolUse, MCP tool
calls, and the VSCode extension). The documented reliable path is
`SessionStart` and `UserPromptSubmit`, where exit-0 stdout is injected. Design against
those two. `TeammateIdle` is interesting as a "pull the next task when an agent goes
idle" trigger, but it should be treated as unverified until tested.

### 4.2 Handoff transport

`PROPOSED, hub decides:`

```
POST   /handoffs/{id}/versions      publish a new immutable version
GET    /handoffs/{id}               metadata plus per-consumer state
GET    /handoffs/{id}/versions/{n}  fetch one version's content
GET    /inbox                       what is waiting for the caller
POST   /handoffs/{id}/consume       mark consumed by the calling repo
```

`ASSUMED, not verified:` publishing must not require the source branch to be pushed or
merged. That is the entire point of the transport. The `source.json` in the mirror
records a commit sha that may not exist remotely yet; a later reconcile step can attach
the real sha once the branch lands. How Hub represents an unmerged source is a Hub
decision, but it must not reject the publish.

### 4.3 Compatibility

`ASSUMED, not verified:` because `knowns` and `knowns-hub` are separate repositories on
separate release cycles, we need this from the second commit rather than after the
first mismatch:

- `GET /version` returning an API version.
- A written compatibility rule. A CLI meeting an older Hub must produce a clear message,
  not a 500.
- A versioned wire contract living in one place that both repositories read.

We note without irony that `knowns` and `knowns-hub` are exactly the two-repository
split this product exists to serve. Using `kn-handoff` for changes between them is the
best available dogfood, and any friction we feel is friction a customer would feel.

---

## 5. Data requirements

### 5.1 Fields the CLI needs back from the inbox

Enough to render a line a human can act on and an agent can reason about, without a
second round trip:

```
handoff_id, version, state, my_version, stale (bool),
diff_summary, assigned_to, from_repo, to_repos[], updated_at
```

`ASSUMED, not verified:` `diff_summary` is a short human-readable string, not a
structured diff. If the Hub side would rather return structured field-level changes,
that is better, and the CLI can render it.

### 5.2 Permissions: four axes, not one

This is the section we most want the Hub side to push back on, because it is the least
settled and the most consequential.

A Hub document or object is constrained along four independent axes:

| Axis | Values | Question it answers |
|---|---|---|
| **Audience** | `workspace` / `repos[]` / `members[]` / `owner` | Which people may see it at all |
| **Actor type** | `human` / `agent` | May a model read it, or only a person |
| **Content level** | `full` / `metadata` | The whole document, or only that it exists |
| **Origin** | `hub` / `published` / `referenced` | Who owns the truth for it |

The axes are independent. A document can be readable by the whole workspace, but only
by humans. Another can be readable by one member and by their agent. Another can be
visible as a title and an owner to everyone, with content restricted to one repository.

**Actor type is the axis that does not exist in comparable products, and it is the one
we care most about.**

Related prior work on the CLI side, worth reading before designing this:
`knowns/.knowns/docs/research/ai-permission-model.md`. It covers the complementary
axis, what an AI session is allowed to **write** (update, archive, delete, publish,
overwrite on generation), and observes that Knowns today has distributed safeguards
rather than one coherent policy model. This brief is about what an AI session is
allowed to **read**. The two axes should probably share one capability layer rather
than becoming two unrelated mechanisms, and the Hub side may be the right place to
settle that shape first.

`ASSUMED, not verified:` some business documents can be read by a teammate but must
never enter a model's context, because that means sending them to a model provider.
Client contract terms, personal data, legal text, compensation, anything under a strict
NDA. Today a team either keeps that material entirely out of their tooling or accepts
that any agent may pick it up. Neither is acceptable.

`PROPOSED, hub decides:` three settings on that axis.

| `ai_access` | An agent caller receives | A human caller receives |
|---|---|---|
| `allow` | Full content | Full content |
| `metadata_only` | Title, owner, tags, "content restricted" | Full content |
| `deny` | Nothing. The object does not appear at all | Full content |

The distinction between `metadata_only` and `deny` matters. Under `metadata_only` an
agent can tell its developer "there is a document about refund approval thresholds,
owned by @be-dev, that I am not permitted to read" - useful, and no leak. Under `deny`
the agent cannot learn the document exists, which is what some material requires.

`ASSUMED, not verified:` **enforcement must be server-side and keyed off the token, not
off a client-supplied header.** A client that declares its own actor type can lie.
This suggests distinct token kinds:

| Token kind | Issued to | Actor type |
|---|---|---|
| Session token | The web UI, after a human logs in | `human` |
| Agent token | A machine, used by the hook and by MCP | `agent` |

The same person holding both tokens sees different results through different channels,
by design.

Every agent-facing path is therefore subject to `ai_access`: the `/hooks/inbox`
response, MCP `search` and `retrieve`, and any future agent-facing endpoint. The web UI
is the only human path.

**Honest limitation, stated rather than hidden:** Hub can enforce the channel, not the
human. A person who reads a `deny` document in the web UI and pastes it into their
agent has defeated the control. `ai_access` is a guardrail against accidental ingestion
and a compliance statement about what the system does on its own, not a technical
guarantee about what a determined person can do. We would rather the Hub documentation
say this plainly than imply a stronger promise.

`ASSUMED, not verified:` per-member restriction ("developer A cannot read developer B's
material") is expected to be rare for business documents, which are usually
workspace-wide or repo-scoped. It matters far more for the presence data in 5.3. If the
Hub side finds per-member document permissions cheap to implement on the same
mechanism, we would take them; if they add real complexity, `workspace` and `repos[]`
alone would cover the cases we can currently name.

### 5.3 Presence: what Hub knows about local work

`PROPOSED, hub decides:` the Hub can usefully know that a developer's agent is busy,
without knowing what it is doing. Three tiers:

| Tier | Hub stores | Team sees | Owner sees |
|---|---|---|---|
| `presence` **(default)** | Count of active local tasks, state, linked `handoff-id`, last update time | Yes | Yes |
| `titles` | Plus task titles | Yes | Yes |
| `full` (opt-in) | Plus plan, acceptance criteria, notes, file references | No | Yes |

`presence` alone produces the row that matters:

```
hof-2026-08-24-order-refund  v2 implemented
  knowns-web     2 tasks active   consumed v2   updated 14 minutes ago
  knowns-mobile  1 task active    stale v1      updated 3 days ago
```

What the team needs is rhythm and divergence, not content.

Two cautions from the CLI side:

- `titles` leaks more than it appears to. "Fix token refresh in useRefund hook" already
  discloses module structure. If only two tiers are built, we suggest dropping `titles`
  rather than dropping `full`.
- The default decides everything, because almost nobody changes a setting. If the
  default is `full`, the claim that implementation detail stays on the developer's
  machine is true only on paper.

`ASSUMED, not verified:` the honest reason to build the `full` tier is continuity for
one person across their own machines and across context compaction, not hiding work
from teammates. We suggest it is documented that way.

`PROPOSED, hub decides, and safe to defer:` file-collision detection between two agents
could be done by sending hashed paths rather than paths. Matching hashes reveal a
collision without revealing a filename. Not needed now, but it affects the schema if
it is ever wanted.

---

## 6. Questions for the Hub side

Ordered by how much the answer changes the design.

1. **Does Hub accept the two-entity split**, where repository knowledge stays in git and
   Hub holds only business knowledge plus coordination state? The current
   `knowns-hub/PRODUCT.md` states that "documents and coordination are equal cores".
   If both cores are equal, Hub owns a document store, an ingest pipeline, and an asset
   store, and the CLI side would like to understand how drift against git is prevented.

2. **Is `ai_access` implementable on the same permission mechanism as `audience`**, or
   does actor-type enforcement cut across the model badly enough to warrant a different
   design? If it is expensive, we need to know before it is promised to anyone.

3. **How does Hub distinguish an agent caller from a human caller?** We proposed token
   kinds. If the Hub already has an auth model with a better answer, that answer wins.

4. **Does Hub want per-`(handoff, consumer)` state from the start?** The alternative is
   handoff-level state and a later migration. The `stale` row is the highest-value
   output of the entire system, so we suspect it should be structural rather than
   retrofitted.

5. **Is publish-before-merge acceptable in the Hub's model of a repository?** A contract
   at `agreed` references a commit that may exist only on an unpushed local branch.

6. **Does Hub want to enforce the "real examples, not prose" rule on `agreed` contracts,
   or only record it?** Enforcement makes parallel work safer and makes publishing more
   annoying.

7. **What is the deployment target the Hub side is designing for?** The current
   `docker-compose.full.yml` runs web, api, migrate, auth-migrate, postgres, redis,
   qdrant, minio. For a self-hosted product with a three-person team as a realistic
   user, deployment weight is likely to be the main adoption constraint. If sections
   3.6 and 5 are accepted, `minio` has no remaining purpose and `qdrant` could plausibly
   be replaced by `pgvector` in the postgres instance that already exists. This is a
   Hub decision and we may be missing a requirement that justifies both.

8. **Who is expected to write business documents?** The model assumes someone owns the
   business layer. A three-person all-developer team often has no such person. We
   suggest a Hub task must be creatable without a document, so that the absence of a
   writer does not block the coordination path, but this is a product decision.

9. **`knowns-hub` currently has no git remote configured and a single commit.** Before
   any wire contract is agreed, we should confirm where that repository is going to
   live, because the compatibility work in 4.3 depends on it.

---

## 7. Risks and dependencies

**Where the CLI side blocks on a Hub decision.**

- Everything in section 4 blocks on the endpoint shapes. The CLI can build the local
  half (`handoff publish`, `inbox`, `pull`, `task create --from-handoff`) against a git
  transport first, which is exactly what we suggest doing while the Hub is decided.
- The `agreed` lifecycle state is a CLI-side change to the `kn-handoff` skill and can
  proceed independently. It does not need the Hub.
- Adding a handoff inbox to the existing `runtime-memory` hook is a CLI-side change and
  can also proceed independently, initially reading from a git transport.

**Risks we can name.**

| Risk | Why it matters |
|---|---|
| The producer does not publish early | `agreed` asks a developer to commit to a contract before writing the code. If team culture does not change, none of the parallelism is realised. This is the largest risk and it is not technical. |
| Mock drift | A consumer builds against `agreed` for three days and the contract moves to `v2`. Versioning and diffs contain it, but rework is the price of parallel work and should be stated. |
| Nobody runs the inbox | Mitigated by the hook, which the harness runs rather than the model. If the inbox is a command a person must remember, the system reverts to the status quo. |
| Hub becomes a document dump | Every wiki ends this way. The boundary is that Hub holds *why* and *what*, and local holds *how*. The first "how to deploy service X" document on Hub is the day the boundary starts eroding. |
| Two indexes confuse agents | The CLI indexes the local store, Hub indexes cross-repo artifacts. Without an explicit routing rule in the skills, agents will query both or query the wrong one. |
| Hub latency on every prompt | The hook runs on every prompt from every developer. This must fail open, with a short timeout. |
| Version skew between the two repositories | Two repositories, two release cycles, one maintainer. Section 4.3 exists for this. |

**Dependency worth noting.** `knowns-hub/apps/` currently contains roughly 466 source
files on a Bun and NestJS stack, with one commit dated 2026-05-12. The CLI side does not
know how much of that is working software and how much is scaffolding. That answer
affects how much of this brief is new construction and how much is re-pointing existing
code, and it is a question only the Hub side can answer.

---

## 8. Acceptance criteria from the CLI side

What must be true for the Hub to unblock CLI work, and how the CLI will verify it.

1. A handoff version can be published from machine A and read from machine B **without
   the source branch having been pushed or merged**. Verified by publishing from a
   dirty local branch and pulling on a second machine.

2. `GET /inbox` returns assignments, stale contracts, and doc version changes for the
   authenticated member **by deterministic query, with no relevance ranking anywhere in
   the path**. Verified by publishing twenty unrelated handoffs and confirming the one
   relevant stale contract is always returned.

3. The hook endpoint returns a valid `hookSpecificOutput.additionalContext` payload and
   **fails open**. Verified by stopping the Hub and confirming a developer's session is
   unaffected apart from the missing notification.

4. Per-consumer state is queryable: for one handoff with two consumer repositories, the
   response distinguishes a consumer on `v2` from a consumer still on `v1`. Verified by
   the `stale` row appearing for exactly one of them.

5. A document with `ai_access: deny` **does not appear** in any agent-facing response,
   including `/hooks/inbox`, MCP `search`, and MCP `retrieve`, while remaining readable
   in the web UI by a permitted human. Verified by querying the same document with an
   agent token and a session token and diffing the results.

6. A document with `ai_access: metadata_only` returns title, owner, and a restriction
   marker to an agent caller, and never returns content. Verified the same way.

7. Actor type is derived from the token, **not from a request header or body field**.
   Verified by attempting to read a `deny` document with an agent token carrying a
   forged human actor claim, and confirming it is refused.

8. Local task state propagates up to the Hub task, and **nothing propagates down**.
   Verified by editing a Hub task and confirming the local store is untouched.

9. `GET /version` exists and a documented compatibility rule is followed, so that a CLI
   meeting an incompatible Hub reports it clearly rather than failing opaquely.

---

## Open questions carried

Sections 6.1 through 6.9 are all open. The three that most change the shape of the work:
the two-entity split (6.1), whether `ai_access` fits the permission model (6.2), and the
deployment target (6.7).

## What this brief deliberately does not do

It proposes no schema, no migration, no framework, and no storage engine. Where it names
a technology it is to expose a constraint the CLI side believes exists, not to make the
choice. The Hub side knows that codebase and those trade-offs better.
