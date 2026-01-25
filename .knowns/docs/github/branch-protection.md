---
title: Branch Protection Rules
createdAt: '2026-01-06T07:55:48.545Z'
updatedAt: '2026-01-06T07:56:03.304Z'
description: GitHub ruleset configuration for protecting main branch
tags:
  - github
  - security
  - rules
---
# Branch Protection Rules

GitHub Ruleset configuration for protecting the main branch.

## Ruleset: main-protection

**Location:** Repository → Settings → Rules → Rulesets

### Target

- Branch: `main`
- Enforcement: Active

## Rules Configuration

### Restrict deletions ✅

Prevent branch deletion.

### Restrict force pushes ✅

Prevent force push to main.

### Require a pull request before merging ✅

All changes must go through PR.

**Sub-options:**

| Setting | Value |
|---------|-------|
| Required approvals | 1 |
| Dismiss stale reviews on new commits | ✅ |
| Require review from Code Owners | Optional |
| Require conversation resolution | ✅ |

### Require status checks to pass ✅

CI must pass before merge.

**Required checks:**
- `test` (from CI workflow)

**Sub-options:**

| Setting | Value |
|---------|-------|
| Require branches to be up to date | ✅ |

### Optional Rules

| Rule | Recommendation |
|------|----------------|
| Require signed commits | Optional (for high security) |
| Require linear history | Optional (if prefer squash only) |

## Setup Steps

1. Go to **Settings → Rules → Rulesets**
2. Click **"New ruleset"**
3. Name: `main-protection`
4. Target: Branch `main`
5. Configure rules as above
6. Click **"Create"**

## Bypass List

Add users/teams who can bypass (emergency only):
- Repository admins
- Specific maintainers

## Testing

After setup, try:

```bash
# This should fail
git push origin main --force

# This should fail
git push origin :main

# PR without approval should not merge
```

## Troubleshooting

### "Required status check is expected"

- Ensure CI workflow runs on PRs
- Check the job name matches (`test`)

### "Branch is not up to date"

```bash
git fetch origin
git rebase origin/main
git push --force-with-lease
```

### "Require approval from reviewers"

- At least 1 reviewer must approve
- Request review from team members
