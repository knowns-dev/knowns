---
name: kn-research
description: Use when you need to understand existing code, find patterns, search project knowledge, investigate current external facts, or explore a large codebase before implementation
---

# Researching the Codebase

**Announce:** "Using kn-research for [topic]."

**Core principle:** UNDERSTAND WHAT EXISTS BEFORE ADDING NEW CODE.

Research is read-only by default. Do not create or update tasks, docs, memories, decisions, or source files unless the user explicitly requests persistence or an approved parent workflow already authorizes it.

## Inputs

- Topic, feature, API, error, file pattern, or task ID
- Suspected paths, symbols, packages, refs, or external facts to verify

## Search Order

Use the narrowest surface that can answer the question, then widen deliberately:

1. Project docs, memories, and current decisions
2. Structural relations from relevant specs/docs
3. Related and completed tasks
4. Existing code paths and implementations
5. Adjacent tests, templates, and validation logic
6. External sources only when the answer depends on current or upstream information

Do not let external results silently override local source code, project docs, task ACs, or explicit user instructions. Report conflicts.

## Step 1: Search Project Knowledge

Use Knowns search for discovery:

```json
mcp_knowns_search({ "action": "search", "query": "<topic>", "type": "doc" })
mcp_knowns_search({ "action": "search", "query": "<topic>", "type": "memory" })
mcp_knowns_docs({ "action": "get", "path": "<path>", "smart": true })
```

Retrieve relevant accepted/current System Decisions separately when durable project guidance may affect the answer. Memory category `decision` is legacy and is not trusted as a replacement for first-class Decisions.

Use `retrieve` only when the next consumer needs an assembled context pack with citations:

```json
mcp_knowns_search({ "action": "retrieve", "query": "<topic>", "limit": 10 })
```

If MCP is unavailable, fall back to `knowns retrieve "<topic>" --json`.

## Step 2: Expand Structural Context

When Step 1 finds a relevant spec or doc, resolve its relationships before broad keyword task searches:

```json
mcp_knowns_search({ "action": "resolve", "ref": "@doc/<path>{implements}",
  "direction": "inbound", "entityTypes": "task" })
```

Follow explicit refs recursively. Use keyword task search afterward to find unlinked gaps, not to repeat already resolved context.

## Step 3: Search Code

Use code intelligence before raw file reads:

```json
mcp_knowns_code({ "action": "find", "query": "<symbol/topic>", "limit": 20 })
mcp_knowns_code({ "action": "symbols", "path": "<file>" })
mcp_knowns_code({ "action": "references", "query": "<symbol>", "path": "<file>" })
```

Inspect adjacent tests and call sites before drawing conclusions. Use raw file or shell search only when code intelligence is unavailable or returns no useful entry point after the query has been narrowed. Return to structural navigation when a symbol or likely file is found.

## Step 4: Research External Facts When Needed

Use external research only when local context cannot answer the question or the answer depends on current upstream facts such as library behavior, releases, issues, specifications, pricing, schedules, or regulations.

Before searching:

1. Inspect or discover the external tools available in the current runtime.
2. Select the narrowest capability that can search or retrieve the required source type.
3. Prefer capabilities that expose official or primary sources and exact source references.
4. Fetch and verify the primary source when possible; search snippets alone are not sufficient evidence for important claims.
5. Compare publication or update dates when freshness matters.

Select tools by capability and source quality, not by provider or tool name. Do not require a specific external service.

If no suitable search or retrieval capability is available:

- state the limitation explicitly
- ask for a URL, file, or access when appropriate
- answer only from verified available context
- mark current or external claims as incomplete instead of guessing

Cite exact URLs or source references used. State clearly when upstream information conflicts with repository behavior.

## Large Research and Delegation

Split a large surface into independent tracks only when delegation is available, allowed, and likely to reduce the main context load. Each worker must have:

- one concrete question
- a bounded read/search scope
- a required evidence format
- no overlap with concurrent tracks

Good tracks include finding an existing implementation and tests, tracing one integration path, or verifying one category of current upstream behavior. Inspect worker evidence before relying on it. If delegation is unavailable, execute the same tracks sequentially.

## Shared Output Contract

Return information in this order:

1. **Goal/result** — what was researched, confirmed, ruled out, or left unresolved.
2. **Key details** — evidence, reusable pieces, gaps, conflicts, constraints, and confidence.
3. **Next action** — one command only when a natural handoff exists.

Research findings should normally include:

```markdown
## Research: <topic>

### Result
<concise conclusion>

### Evidence
- `path:line` or @doc/path — local evidence
- <URL or source ref> — external primary evidence

### Reusable vs Missing
- Reuse: <existing pattern or utility>
- Missing/unverified: <gap or unavailable evidence>

### Conflicts and Constraints
- <docs/code/upstream mismatch or architecture constraint>

### Recommendation
- <concrete next step and reason>

### Confidence
High | Medium | Low — <short reason>
```

Omit empty sections. Never fabricate a pattern, source, or confidence level.

## Persistence Boundary

If findings are broadly reusable, recommend a canonical Knowns doc, task, or extraction workflow. Persist only when explicitly authorized; then use Knowns APIs, link the resulting `@doc/`, `@task-`, or `@decision/` reference, and keep the final response concise.

Do not manage platform-synced skill copies; this source defines the built-in workflow contract.

## Checklist

- [ ] Searched relevant project knowledge
- [ ] Followed explicit refs and structural relations when present
- [ ] Reviewed related tasks, code paths, and tests
- [ ] Used external research only when needed and selected tools by capability
- [ ] Cited evidence and reported conflicts or gaps
- [ ] Kept research read-only unless persistence was authorized

## Next Step Suggestion

- active task research → `/kn-plan <task-id>`
- approved spec/task wave ready → `/kn-flow @doc/<spec-path>`
- completed work produced reusable knowledge → `/kn-extract <task-id>`
- no clear handoff → stop after findings
