---
name: kn-commit
description: Use when committing code changes with proper conventional commit format and verification
---

# Committing Changes

**Announce:** "Using kn-commit to commit changes."

**Core principle:** VERIFY BEFORE COMMITTING - check staged changes, ask for confirmation.

## Inputs

- Current staged changes
- Relevant task IDs, scope, and reason for the change

## Preflight

- Confirm the correct files are staged
- Check whether the commit should reference a task or feature area
- Refuse to commit if the staged diff looks unrelated or mixed across multiple concerns

## Step 1: Review Staged Changes

```bash
git status
git diff --staged
```

## Step 2: Generate Commit Message

**Format:**
```
<type>(<scope>): <message>

- Bullet point summarizing change
```

**Types:** feat, fix, docs, style, refactor, perf, test, chore

**Rules:**
- Title lowercase, no period, max 50 chars
- Body explains *why*, not just *what*

## Step 3: Ask for Confirmation

```
Ready to commit:

feat(auth): add JWT token refresh

- Added refresh token endpoint

Proceed? (yes/no/edit)
```

**Wait for user approval.**

## Step 4: Commit

```bash
git commit -m "feat(auth): add JWT token refresh

- Added refresh token endpoint"
```

## Final Response Contract

All built-in skills in scope must end with the same user-facing information order: `kn-init`, `kn-spec`, `kn-flow`, `kn-plan`, `kn-research`, `kn-implement`, `kn-verify`, `kn-doc`, `kn-template`, `kn-extract`, and `kn-commit`.

Required order for the final user-facing response:

1. Goal/result - state whether a commit was proposed, blocked, or created.
2. Key details - include the proposed or final commit message, relevant diff concerns, and approval status.
3. Next action - recommend a concrete follow-up command only when a natural handoff exists.

Keep this concise for CLI use. Skill-specific content may extend the key-details section, but must not replace or reorder the shared structure.

Out of scope: explaining, syncing, or generating `.claude/skills/*`. Runtime auto-sync already handles platform copies, so this skill source only defines the built-in output contract.

For `kn-commit`, the key details should cover:

- the proposed commit title
- 1 short body explaining why
- any concerns about the staged diff
- a clear approval prompt

## Guidelines

- Only commit staged files
- NO "Co-Authored-By" lines
- NO "Generated with Claude Code" ads
- Ask before committing

## Next Step Suggestion

When a follow-up is natural, recommend exactly one next command:

- after proposing a commit: no command, wait for approval
- after a successful commit tied to active work: `/kn-verify`
- after a successful standalone commit: `/kn-extract` or the next task-specific workflow command if one is obvious

## Checklist

- [ ] Reviewed staged changes
- [ ] Message follows convention
- [ ] User approved
- [ ] Next action suggested when applicable

## Abort Conditions

- Nothing staged
- Staged diff includes unrelated work that should be split
- User has not explicitly approved the final message
