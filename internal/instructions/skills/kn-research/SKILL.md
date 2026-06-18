---
name: kn-research
description: Use when you need to understand existing code, find patterns, or explore the codebase before implementation
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

## Step 4: Search Codebase

```bash
find . -name "*<pattern>*" -type f | grep -v node_modules | head -20
grep -r "<pattern>" --include="*.ts" -l | head -20
```

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
