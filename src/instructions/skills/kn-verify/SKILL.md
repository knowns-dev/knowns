---
name: kn-verify
description: Use when running SDD verification and coverage reporting
---

# SDD Verification

Run validation with SDD-awareness to check spec coverage and task status.

**Announce:** "Using kn-verify to check SDD status."

**Core principle:** VERIFY SPEC COVERAGE → REPORT WARNINGS → SUGGEST FIXES.

## Step 1: Run SDD Validation

### Via CLI
```bash
knowns validate --sdd --plain
```

### Via MCP (if available)
```json
mcp__knowns__validate({ "scope": "sdd" })
```

## Step 2: Present SDD Status Report

Display the results in this format:

```
SDD Status Report
═══════════════════════════════════════
Specs:    X total | Y approved | Z draft
Tasks:    X total | Y done | Z in-progress | W todo
Coverage: X/Y tasks linked to specs (Z%)

⚠️ Warnings:
  - task-XX has no spec reference
  - specs/feature: X/Y ACs incomplete

✅ Passed:
  - All spec references resolve
  - specs/auth: fully implemented
```

## Step 3: Analyze Results

**Good coverage (>80%):**
> SDD coverage is healthy. All tasks are properly linked to specs.

**Medium coverage (50-80%):**
> Some tasks are missing spec references. Consider:
> - Link existing tasks to specs: `knowns task edit <id> --spec specs/<name>`
> - Create specs for unlinked work: `/kn-spec <feature-name>`

**Low coverage (<50%):**
> Many tasks lack spec references. For better traceability:
> 1. Create specs for major features: `/kn-spec <feature>`
> 2. Link tasks to specs: `knowns task edit <id> --spec specs/<name>`
> 3. Use `/kn-plan --from @doc/specs/<name>` for new tasks

## Step 4: Suggest Actions

Based on warnings, suggest specific fixes:

**For tasks without spec:**
> Link task to spec:
> ```bash
> knowns task edit <id> --spec specs/<name>
> ```

**For incomplete ACs:**
> Check task progress:
> ```bash
> knowns task <id> --plain
> ```

**For approved specs without tasks:**
> Create tasks from spec:
> ```
> /kn-plan --from @doc/specs/<name>
> ```

## Checklist

- [ ] Ran validate --sdd
- [ ] Presented status report
- [ ] Analyzed coverage level
- [ ] Suggested specific fixes for warnings

## Red Flags

- Ignoring warnings
- Not suggesting actionable fixes
- Skipping coverage analysis
