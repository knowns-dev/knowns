---
name: kn-extract
description: Use when extracting reusable patterns, decisions, failures, or knowledge into documentation
---

# Extracting Knowledge

**Announce:** "Using kn-extract to extract knowledge."

**Core principle:** CAPTURE ONLY GENERALIZABLE KNOWLEDGE, WITH PROVENANCE.

## Inputs and Modes

- Completed task ID, code change, repeated pattern, or recurring failure
- `--consolidate` to review existing learning docs instead of extracting one source

Use Knowns APIs for managed tasks, docs, memories, and decisions. Do not edit their markdown directly.

## Normal Extraction

### 1. Read the Source

Read the task or referenced work and identify genuine findings in three categories:

| Category | Capture when |
|---|---|
| Pattern | A reusable implementation, architecture, integration, or process approach exists |
| Retrospective learning | A good call, bad call, surprise, trade-off, or failure can improve future work |
| System Decision | Stable guidance future work must follow: architecture, behavior, naming, storage, API contract, workflow convention, or explicit trade-off |

Do not fabricate findings. A valid no-op is better than generic advice.

### 2. Search Before Creating

Search docs, memories, and current Decisions for overlap. Prefer updating a canonical doc over creating a duplicate.

```json
mcp_knowns_search({ "action": "search", "query": "<topic>", "type": "doc" })
mcp_knowns_search({ "action": "search", "query": "<topic>", "type": "memory" })
```

### 3. Persist the Right Artifact

- **Pattern or detailed learning:** create/update a Knowns doc and link the source task/doc.
- **Fast recall:** save a concise project Memory that links the canonical doc. Use only `pattern`, `convention`, `preference`, or `failure` categories.
- **Stable guidance:** create a first-class draft System Decision candidate with task/doc/source provenance. Never auto-accept it.
- **Generatable pattern:** create a template only when repeated generation is genuinely useful and a linked pattern doc exists.

Never create Memory category `decision`. Spec Decisions remain canonical in an approved spec's `Locked Decisions` section and must not be copied into the System Decision ledger.

A System Decision candidate must remain non-current until explicit verified resolution. If it replaces current guidance, use the reviewed supersession flow rather than overwriting the old Decision.

### 4. Promote Sparingly

Promote a learning to `learnings/critical-patterns` only when it:

- applies to multiple future features
- would avoid at least substantial repeated effort
- is concrete and generalizable

Keep promoted entries concise and link the full canonical doc. Avoid turning the critical list into a second knowledge dump.

### 5. Validate and Link Back

Validate every created or updated doc/template/Decision ref. Append one concise source-task note containing the canonical refs. Do not mark unrelated task ACs or change task status.

## Consolidation Mode

When `--consolidate` is present:

1. List learning docs and inspect likely duplicate/outdated/orphan clusters; do not load every full document before narrowing candidates.
2. Classify proposed actions as merge, update, promote, repair ref, archive, or no-op.
3. Present a compact preview with reasons and target canonical paths.
4. Require explicit user approval before destructive, archival, supersession, or broad rewrite actions.
5. Apply approved changes through Knowns APIs and validate affected entities.
6. Report merged/updated/promoted/repaired counts and unresolved candidates.

Never delete or overwrite a document merely because titles look similar. Compare content and provenance first.

## Shared Output Contract

Return information in this order:

1. **Goal/result** — what was extracted, consolidated, or intentionally left as a no-op.
2. **Key details** — canonical docs, memories, Decision candidates, templates, provenance, and validation.
3. **Next action** — one command only when a natural handoff exists.

Include what now serves as the canonical knowledge source. If nothing generalizable was found, say so plainly.

## Checklist

- [ ] Source and provenance verified
- [ ] Existing knowledge searched before creation
- [ ] Patterns, retrospective learnings, failures, and durable guidance distinguished correctly
- [ ] No legacy Decision Memory or duplicated Spec Decision created
- [ ] Critical promotion calibrated
- [ ] Destructive consolidation actions explicitly approved
- [ ] Affected entities validated and linked back
