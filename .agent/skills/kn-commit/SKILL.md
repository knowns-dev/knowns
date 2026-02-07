---
name: kn-commit
description: Use when committing code changes with proper conventional commit format and verification
---

# Committing Changes

**Announce:** "Using kn-commit to commit changes."

**Core principle:** VERIFY BEFORE COMMITTING - check staged changes, ask for confirmation.

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

## Guidelines

- Only commit staged files
- NO "Co-Authored-By" lines
- NO "Generated with Claude Code" ads
- Ask before committing

## Checklist

- [ ] Reviewed staged changes
- [ ] Message follows convention
- [ ] User approved