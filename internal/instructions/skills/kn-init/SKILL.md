---
name: kn-init
description: Use at the start of a new session to read project docs, understand context, and see current state
---

# Session Initialization

**Announce:** "Using kn-init to initialize session."

**Core principle:** BOOTSTRAP WITH MCP INITIAL → DISCOVER WITH HELP → READ ONLY RELEVANT DOCS.

## Inputs

- Optional user focus such as a task ID, feature area, bug, or question
- Current project root already opened in the agent session

## Preflight

- Confirm this is a Knowns project
- Call MCP `initial` first when available; it is the runtime bootstrap
- Use `help("tool.*")` or `help("workflow.*")` when an action schema or workflow route is not visible
- Prefer project docs over guessing from code structure
- If `README`, `ARCHITECTURE`, or `CONVENTIONS` do not exist, choose the closest equivalents from the docs list
- If a doc is large, read its TOC first and only open the relevant sections

## Step 1: Runtime Bootstrap

```json
mcp_knowns_initial({})
```

If the MCP client exposes the tool as `initial` rather than `mcp_knowns_initial`, call that tool. Summarize project state, tool domains, active timer, and any warnings.

## Step 2: List Docs

```json
mcp_knowns_docs({ "action": "list" })
```

## Step 3: Read Core Docs

```json
mcp_knowns_docs({ "action": "get", "path": "README", "smart": true })
```

For large docs, do not read the whole file. Use:

```json
mcp_knowns_docs({ "action": "get", "path": "<path>", "toc": true })
mcp_knowns_docs({ "action": "get", "path": "<path>", "section": "<heading-or-number>" })
```

## Step 4: Check Current State

```json
mcp_knowns_tasks({ "action": "list", "status": "in-progress" })
mcp_knowns_tasks({ "action": "board" })
```

## Step 4.5: Load Critical Learnings

Check for accumulated critical learnings from past work:

```json
mcp_knowns_search({ "action": "search", "query": "critical patterns", "type": "doc", "tag": "critical" })
```

If `learnings/critical-patterns` exists:
```json
mcp_knowns_docs({ "action": "get", "path": "learnings/critical-patterns", "smart": true })
```

These are promoted learnings that cost the most to discover and save the most by knowing. Include a brief summary in the session context if any exist.

## Step 4.6: Load Project Memory

```json
mcp_knowns_memory({ "action": "list", "layer": "project" })
```

Project memories contain accumulated patterns, decisions, and conventions from past work. Include key entries in the session context summary. If there are many entries, prioritize by recency and relevance to the user's stated focus.

## Step 4: Summarize

```markdown
## Session Context
- **Project**: [name]
- **Key Docs**: README, ARCHITECTURE, CONVENTIONS
- **Critical Learnings**: [count, or "none yet"]
- **Project Memories**: [count, or "none yet"]
- **In-progress tasks**: [count]
- **Current risks / gaps**: [missing docs, unclear conventions, broken search, etc.]
- **Ready for**: tasks, docs, questions
```

## Final Response Contract

All built-in skills in scope must end with the same user-facing information order: `kn-init`, `kn-spec`, `kn-flow`, `kn-plan`, `kn-research`, `kn-implement`, `kn-verify`, `kn-doc`, `kn-template`, `kn-extract`, and `kn-commit`.

Required order for the final user-facing response:

1. Goal/result - state what session context was established or what was confirmed.
2. Key details - include only the most important supporting context, refs, risks, or current-state notes.
3. Next action - recommend a concrete follow-up command only when a natural handoff exists.

Keep this concise for CLI use. Skill-specific content may extend the key-details section, but must not replace or reorder the shared structure.

Out of scope: explaining, syncing, or generating `.claude/skills/*`. Runtime auto-sync already handles platform copies, so this skill source only defines the built-in output contract.

For `kn-init`, the key details should cover:

- 1 short paragraph or bullet list summarizing project purpose and architecture
- 1 short list of the most relevant docs opened
- current in-progress work, if any
- current risks or missing context, if any

## Fallbacks

- If task search/list is unavailable, state that clearly and continue with docs + codebase context
- If core docs are missing, say which docs were not found and which substitutes were used
- If `initial` is unavailable, fall back to `project({ action: "status" })` and targeted docs
- Do not invent project conventions that were not found in docs or code

When a follow-up is natural, recommend exactly one next command such as:

```
/kn-plan <task-id>
/kn-flow @doc/<approved-spec-path>
/kn-research <query>
```
