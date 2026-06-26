---
name: kn-research
description: Use when you need to understand existing code, find patterns, search project knowledge, use web research for external/current facts, or explore a large codebase before implementation
---

# Researching the Codebase

**Announce:** "Using kn-research for [topic]."

**Core principle:** UNDERSTAND WHAT EXISTS BEFORE ADDING NEW CODE.

## Inputs

- Topic, feature, API, error, file pattern, or task ID
- Any suspected file paths, package names, or existing references

## Search Order

1. Project docs and memories (unified search)
2. Expand context via structural relations (if spec/doc found)
3. Completed or related tasks (keyword search for gaps)
4. Existing code paths and implementations
5. Adjacent tests, templates, and validation logic
6. External MCP providers when repo context depends on current/upstream facts
7. General web search only when specialized MCP/external providers are unavailable or insufficient

## Research Scope Policy

Use the narrowest search surface that can answer the question, then widen deliberately.

- Use Knowns `search` first for project context: docs, tasks, memories, and decisions.
- Use `retrieve` when the next consumer needs a cited context pack, not for every lookup.
- Use MCP/code intelligence (`code.find`, `code.symbols`, `code.references`, `code.definition`) for code structure before raw file reads.
- Use specialized external MCP providers when available and relevant, before general web search. Examples: Context7/library-doc MCP for framework or package docs, GitHub/source MCP for issues or repository state, official-docs MCP for vendor APIs.
- Use web/internet search only when specialized MCP providers are unavailable, insufficient, or the user explicitly asks to search online.
- Prefer primary sources for external research: official docs, source repos, release notes, specifications, issue threads, or MCP results backed by those sources. Cite sources in findings when the tool exposes them.
- Do not let external results override local source code, project docs, task ACs, or explicit user instructions without calling out the conflict.

## Large Research / Sub-Agent Delegation

If the research surface is too large for one pass, split it into independent tracks before reading everything.

Use sub-agents when all are true:

- the runtime exposes sub-agent/delegation tools and current runtime policy allows them
- the tracks can be answered independently
- each worker has a concrete question, bounded read scope, and expected output
- the worker output will materially reduce the main context load

Good delegated research tracks:

- "Find existing auth middleware patterns and tests."
- "Inspect Web UI docs/API routes for current behavior."
- "Use Context7 or an official-docs MCP to inspect current library behavior."

Avoid delegating overlapping broad asks like "research the whole repo." While workers run, continue non-overlapping local research. Inspect worker findings before relying on them. If sub-agent tools are unavailable or not allowed, execute the same split sequentially in the main context.

## Step 1: Search Documentation and Memory

```json
mcp_knowns_search({ "action": "search", "query": "<topic>", "type": "doc" })
mcp_knowns_search({ "action": "search", "query": "<topic>", "type": "memory" })
mcp_knowns_docs({ "action": "get", "path": "<path>", "smart": true })
```

Unified search returns docs and memory entries. If relevant memories appear, include them in findings and note whether they're still current.

Use `search` for discovery-first research. Only use `retrieve` when the next consumer needs assembled context with citations rather than raw hits:
```json
mcp_knowns_search({ "action": "retrieve", "query": "<topic>" })
```
If MCP is unavailable, fall back to CLI: `knowns retrieve "<topic>" --json`

## Step 2: Expand Context via Relations

If Step 1 found a spec or doc relevant to the topic, use structural resolve to discover related tasks, dependencies, and implementation status **before** searching tasks by keyword. This gives a complete picture of what already exists.

```json
// Found specs/ai-permission-model in Step 1 → find all tasks implementing it
mcp_knowns_search({ "action": "resolve", "ref": "@doc/specs/<found-path>{implements}", "direction": "inbound", "entityTypes": "task" })

// Found a doc that others depend on → find what depends on it
mcp_knowns_search({ "action": "resolve", "ref": "@doc/<found-path>{depends}", "direction": "inbound", "depth": 2 })
```

Skip this step only if Step 1 returned no relevant docs or specs.

## Step 3: Search Completed Tasks

```json
mcp_knowns_search({ "action": "search", "query": "<keywords>", "type": "task" })
mcp_knowns_tasks({ "action": "get", "taskId": "<id>" })
```

If Step 2 already found related tasks via structural resolve, focus keyword search on gaps — tasks that might be related but not formally linked.

## Step 4: Search Codebase Through MCP

Use MCP code tools as the primary code research path:

```json
mcp_knowns_code({ "action": "find", "query": "<symbol/topic>", "limit": 20 })
mcp_knowns_code({ "action": "symbols", "path": "<file>" })
mcp_knowns_code({ "action": "references", "query": "<symbol>", "path": "<file>" })
```

Only fall back to raw shell search when MCP/code tools are unavailable, or when MCP/code search returns no useful entry point after narrowing the query. Prefer `rg` over slower shell search tools:

```bash
rg --files | rg "<pattern>"
rg -n "<pattern>" --glob '!node_modules/**'
```

After an `rg` fallback finds likely files or symbols, return to MCP code tools (`symbols`, `definition`, `references`, `diagnostics`) before drawing conclusions.

## Step 4b: Search External MCP / Web Sources When Needed

Use external MCP providers first when local repo context is not enough because the topic depends on current or external information.

Examples:

- current GitHub issue status or release behavior
- official API/library docs
- framework behavior that may have changed
- standards, specs, pricing, schedules, or regulations

Rules:

- use specialized MCP providers such as Context7 before broad web search when they match the domain
- prefer official or primary sources
- compare dates for current information
- include links or source names in findings
- state clearly when an external source conflicts with repo behavior

## Step 5: Document Findings

```markdown
## Research: [Topic]

### Existing Implementations
- `src/path/file.ts`: Does X

### Patterns Found
- Pattern 1: Used for...

### Related Docs
- @doc/path1 - Covers X

### Recommendations
1. Reuse X from Y
2. Follow pattern Z
```

## Shared Output Contract

All built-in skills in scope must end with the same user-facing information order: `kn-init`, `kn-spec`, `kn-flow`, `kn-plan`, `kn-research`, `kn-implement`, `kn-verify`, `kn-doc`, `kn-template`, `kn-extract`, and `kn-commit`.

Required order for the final user-facing response:

1. Goal/result - state what was researched, clarified, or ruled out.
2. Key details - include the most important supporting context, refs, constraints, gaps, or warnings.
3. Next action - recommend a concrete follow-up command only when a natural handoff exists.

Keep this concise for CLI use. Research-specific content may extend the key-details section, but must not replace or reorder the shared structure.

Out of scope: explaining, syncing, or generating `.claude/skills/*`. Runtime auto-sync already handles platform copies, so this skill source only defines the built-in output contract.

For `kn-research`, the key details should cover:

- concrete files or docs found
- what is reusable vs what is missing
- architecture or convention constraints discovered

## Knowledge Spillover Rule

If the research surface becomes too large for one response or one task:

- create or update a Knowns doc for the reusable/domain knowledge
- reference that doc from the current task or plan with `@doc/<path>`
- keep the research summary short and point to the canonical doc instead of repeating everything inline

If the research uncovers a broad follow-up topic that should be tracked independently:

- create a task for that general knowledge or follow-up work
- reference it with `@task-<id>` from the current context
- do not silently expand the original task with unrelated background work

## Fallbacks

- If search is noisy, narrow by file type, feature folder, or known reference IDs
- If no existing pattern is found, state that explicitly rather than implying one exists
- If docs and code disagree, call out the mismatch

## Checklist

- [ ] Searched documentation
- [ ] Expanded context via structural resolve (if spec/doc found)
- [ ] Reviewed similar completed tasks
- [ ] Found existing code patterns
- [ ] Identified reusable components

## Next Step Suggestion

Only suggest a next command when the findings clearly lead somewhere:

- research for an active task -> `/kn-plan <task-id>`
- research confirms an approved spec/task wave is ready to execute -> `/kn-flow @doc/<spec-path>`
- research uncovered reusable knowledge -> `/kn-extract <task-id>` if the source task is complete
- no clear handoff -> stop after the findings without forcing a next command
