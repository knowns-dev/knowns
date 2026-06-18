---
name: kn-extract
description: Use when extracting reusable patterns, decisions, failures, or knowledge into documentation
---

# Extracting Knowledge (with Compounding)

**Announce:** "Using kn-extract to extract knowledge."

**Core principle:** EXTRACT PATTERNS + DECISIONS + FAILURES → COMPOUND LEARNINGS.

## Inputs

- Usually a completed task ID
- Sometimes a code change, repeated pattern, or recurring support issue
- Optional: `--compound` flag for full 3-category analysis
- Optional: `--consolidate` flag to review and consolidate all existing learnings

## Mode Detection

Check `$ARGUMENTS`:
- Contains `--consolidate` → Go to "Consolidation Mode" section
- Otherwise → Continue with normal extraction flow

## Extraction Rules

- Extract patterns, decisions, AND failures — not just code patterns
- Prefer updating an existing doc over creating a duplicate
- Link the extracted knowledge back to the source task or source doc
- Create or supersede a first-class Decision when the extracted knowledge is durable guidance for future work
- Only create a template if the pattern is genuinely reusable for generation
- Promote critical learnings to `learnings/critical-patterns` for future `kn-init` sessions

## Step 1: Identify Source

```json
mcp_knowns_tasks({ "action": "get", "taskId": "$ARGUMENTS" })
```

Look for three categories:

| Category | What to look for |
|----------|-----------------|
| **Patterns** | Reusable code patterns, architecture approaches, integration techniques |
| **Decisions** | Durable choices, supersessions, good calls, bad calls, trade-offs, surprises |
| **Failures** | Bugs, wrong assumptions, wasted effort, missing prerequisites |

## Step 2: Search for Existing Docs

```json
mcp_knowns_search({ "action": "search", "query": "<pattern/topic>", "type": "doc" })
```

**Don't duplicate.** Update existing docs when possible.

## Step 3: Three-Category Analysis

### 3a. Patterns

Identify reusable patterns:
- Code patterns: new utilities, abstractions worth standardizing
- Architecture patterns: structural decisions that worked
- Process patterns: workflow approaches that saved time

### 3b. Decisions

Identify significant decisions:
- **GOOD_CALL**: decisions that proved correct or saved time
- **BAD_CALL**: decisions that required rework
- **SURPRISE**: things that turned out differently than expected
- **TRADEOFF**: conscious choices where alternatives were considered

### 3c. Failures

Identify failures and wasted effort:
- Bugs introduced and root causes
- Wrong assumptions that required backtracking
- Missing prerequisites discovered mid-execution
- Test gaps that allowed regressions

---

### 3d. First-Class Decisions

If a decision is current guidance rather than only a retrospective learning, capture it as a Decision:

- Use Decision for stable project guidance: architecture, product behavior, workflow convention, naming, storage model, API contract, or explicit tradeoff
- Link the Decision to the source task, source doc, or related reference
- Supersede existing Decisions when new guidance replaces old guidance
- Do not create Decisions for routine progress notes, one-off bugs, local implementation details, or unresolved ideas

```bash
knowns decision create "<decision title>" \
  --task <task-id> \
  --doc <doc-path> \
  --decision "<current guidance>"
```

```bash
knowns decision supersede <old-decision-id> <new-decision-id>
```

---

## Step 4: Create/Update Documentation

### For patterns → pattern doc (same as before)

```json
mcp_knowns_docs({ "action": "create", "title": "Pattern: <Name>",
  "description": "Reusable pattern for <purpose>",
  "tags": ["pattern", "<domain>"],
  "folder": "patterns"
})
```

### For retrospective decisions + failures → learning doc

```json
mcp_knowns_docs({ "action": "create", "title": "Learning: <feature/domain>",
  "description": "Learnings from <task/feature>",
  "tags": ["learning", "<domain>"],
  "folder": "learnings",
  "content": "<see template below>"
})
```

**Learning doc template:**

```markdown
## Patterns

### <Pattern Name>
- **What:** <description>
- **When to use:** <applicable conditions>
- **Source:** @task-<id>

## Decisions

### <Decision>
- **Chose:** <what was chosen>
- **Over:** <what was rejected>
- **Tag:** GOOD_CALL / BAD_CALL / SURPRISE / TRADEOFF
- **Outcome:** <how it played out>
- **Recommendation:** <for future work>

## Failures

### <Failure>
- **What went wrong:** <description>
- **Root cause:** <not just symptom>
- **Time lost:** <estimate>
- **Prevention:** <what to do differently>
```

## Step 5: Save to Memory

For each extracted pattern or decision worth quick recall, save a concise memory entry alongside the doc:

```json
mcp_knowns_memory({ "action": "add", "title": "<pattern/decision name>",
  "content": "<2-3 sentence summary>. Full reference: @doc/<path>",
  "layer": "project",
  "category": "<pattern|decision|convention|failure>",
  "tags": ["<domain>"]
})
```

Memory = fast agent recall in future sessions. Decision = durable guidance. Doc = full structured reference.
Do NOT duplicate the entire doc content — store a summary and link to the doc.
If a first-class Decision was created, include its `@decision/<id>` ref in the memory or task note when useful.
Skip this step if the extraction produced nothing generalizable.

## Step 6: Create Template (if code-generatable)

```json
mcp_knowns_templates({ "action": "create", "name": "<pattern-name>",
  "description": "Generate <what>",
  "doc": "patterns/<pattern-name>"
})
```

## Step 7: Promote Critical Learnings

For any finding that meets ALL criteria:
- Affects more than one future feature
- Would cause ≥30 minutes wasted effort if unknown
- Is generalizable, not implementation-specific

Check if critical-patterns doc exists:
```json
mcp_knowns_search({ "action": "search", "query": "critical patterns", "type": "doc", "tag": "learning" })
```

**If exists — append:**
```json
mcp_knowns_docs({ "action": "update", "path": "learnings/critical-patterns",
  "appendContent": "\n\n## [Date] <Learning Title>\n**Category:** pattern / decision / failure\n**Source:** @task-<id>\n**Tags:** [tag1, tag2]\n\n<2-4 sentence summary and what to do differently>\n\n**Full entry:** @doc/learnings/<slug>"
})
```

**If not exists — create:**
```json
mcp_knowns_docs({ "action": "create", "title": "Critical Patterns",
  "description": "Promoted learnings that save the most time. Read at session start.",
  "folder": "learnings",
  "tags": ["learning", "critical"],
  "content": "# Critical Patterns\n\nPromoted learnings from completed work. Read this at the start of every session via `kn-init`. These are lessons that cost the most to learn and save the most by knowing.\n\n---"
})
```

**Calibration:** Do NOT promote everything. If critical-patterns grows past 20-30 entries it becomes noise. Only promote learnings that would have saved ≥30 minutes if known in advance.

## Step 8: Validate

**CRITICAL:** After creating doc/template, validate to catch broken refs:

```json
mcp_knowns_validate({ "entity": "<doc-path>" })
```

If errors found, fix before continuing.

## Step 9: Link Back to Task

```json
mcp_knowns_tasks({ "action": "update", "taskId": "$ARGUMENTS",
  "appendNotes": "📚 Extracted to @doc/<path>"
})
```

---

# Consolidation Mode (Dream Lite)

When `$ARGUMENTS` contains `--consolidate`:

**Announce:** "Using kn-extract --consolidate to review and consolidate learnings."

Scan all existing learnings docs, merge duplicates, flag outdated entries, and promote new critical patterns. Run on-demand when the learnings folder feels messy or after a batch of completed work.

## C-Step 1: Scan All Learnings

```json
mcp_knowns_docs({ "action": "list", "tag": "learning" })
```

Read each learning doc:
```json
mcp_knowns_docs({ "action": "get", "path": "<path>", "smart": true })
```

## C-Step 2: Identify Issues

For each learning doc, check:

### Duplicates
- Two docs covering the same root cause or pattern
- Same advice phrased differently across docs
- → Merge into one, delete the other

### Outdated
- Fix/pattern references code that no longer exists
- Advice contradicts current architecture or conventions
- → Update or mark as outdated with date

### Missing Promotions
- Learning that meets critical criteria (affects multiple features, saves ≥30 min) but isn't in critical-patterns
- → Propose promotion

### Orphaned
- Learning that references a task or doc that no longer exists
- → Fix ref or note the context is lost

## C-Step 3: Apply Changes

For each issue found, present to user:

```
Consolidation findings:

1. MERGE: "Learning: auth token" + "Learning: JWT refresh" → same root cause
   → Merge into "Learning: auth token handling"?

2. OUTDATED: "Learning: webpack config" — references webpack.config.js which was removed
   → Mark outdated or delete?

3. PROMOTE: "Learning: Go test race conditions" — saved 2h on 3 separate tasks
   → Promote to critical-patterns?

4. ORPHAN: "Learning: SSE reconnect" — references @task-abc123 which doesn't exist
   → Keep content, remove broken ref?

Apply all? (yes / review each / skip)
```

**If "review each":** present one at a time, apply user's choice.
**If "yes":** apply all suggested changes.

## C-Step 4: Report

```
Consolidation complete:
- Merged: X docs
- Updated: X docs
- Promoted: X to critical-patterns
- Orphans fixed: X
- Total learnings: X docs
```

---

## Shared Output Contract

Required order for the final user-facing response:

1. Goal/result — what knowledge was extracted, updated, or intentionally not extracted.
2. Key details — docs created/updated, critical promotions, template status, validation.
3. Next action — recommend a concrete follow-up command only when a natural handoff exists.

For `kn-extract`, the key details should cover:

- what knowledge was extracted (patterns, decisions, failures)
- whether docs were created or updated
- whether critical learnings were promoted
- whether a template was created
- where the canonical knowledge now lives

When the extraction leads to a clear follow-up, include the best next command. If the correct outcome is a no-op or a completed doc update with no obvious continuation, stop after the result and key details.

## No-Op Case

If the work is too specific to generalize, say so explicitly and do not force a new doc.

**Do NOT fabricate findings.** If the task ran smoothly with no surprises, write that. A short learning with 2 genuine entries is better than a long doc with invented ones.

## What to Extract

| Source | Extract As | Template? |
|--------|------------|-----------|
| Code pattern | Pattern doc | ✅ Yes |
| API pattern | Integration guide | ✅ Yes |
| Durable decision / supersession | Decision | ❌ No |
| Retrospective decision (good/bad) | Learning doc | ❌ No |
| Failure / debugging | Learning doc | ❌ No |
| Error solution | Troubleshooting | ❌ No |
| Security approach | Guidelines | ❌ No |

## Checklist

- [ ] Three categories analyzed (patterns, decisions, failures)
- [ ] Knowledge is generalizable
- [ ] Durable guidance captured as Decision when applicable
- [ ] Includes working example (for patterns)
- [ ] Links back to source
- [ ] Critical learnings promoted (if applicable)
- [ ] Template created (if applicable)
- [ ] **Validated (no broken refs)**

## Red Flags

- Only extracting code patterns, ignoring decisions and failures
- Promoting everything as critical (noise kills the learning loop)
- Writing generic learnings ("test more carefully" is worthless)
- Fabricating findings when the task was straightforward
- Not checking existing docs before creating duplicates
