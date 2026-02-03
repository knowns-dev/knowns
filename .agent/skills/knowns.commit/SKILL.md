---
name: knowns.commit
description: Use when committing code changes with proper conventional commit format and verification
---

# Committing Changes

Create well-formatted commits following conventional commit standards.

**Announce at start:** "I'm using the knowns.commit skill to commit changes."

**Core principle:** VERIFY BEFORE COMMITTING - check staged changes, ask for confirmation.

## The Process

### Step 1: Review Staged Changes

```bash
git status
git diff --staged
```

### Step 2: Generate Commit Message

**Format:**
```
<type>(<scope>): <message>

- Bullet point summarizing change
- Another point if needed
```

**Types:**

| Type | Description |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `style` | Formatting, no code change |
| `refactor` | Code restructure |
| `perf` | Performance improvement |
| `test` | Adding tests |
| `chore` | Maintenance |

**Rules:**
- Title lowercase, no period, max 50 chars
- Scope optional but recommended
- Body explains *why*, not just *what*

### Step 3: Ask for Confirmation

Present message to user:

```
Ready to commit:

feat(auth): add JWT token refresh

- Added refresh token endpoint
- Tokens expire after 1 hour

Proceed? (yes/no/edit)
```

**Wait for user approval.**

### Step 4: Commit

```bash
git commit -m "feat(auth): add JWT token refresh

- Added refresh token endpoint
- Tokens expire after 1 hour"
```

## Guidelines

- Only commit staged files (don't `git add` unless asked)
- NO "Co-Authored-By" lines
- NO "Generated with Claude Code" ads
- Ask before committing, never auto-commit

## Examples

**Good:**
```
feat(api): add user profile endpoint
fix(auth): handle expired token gracefully
docs(readme): update installation steps
```

**Bad:**
```
update code          (too vague)
WIP                  (not ready)
fix bug              (which bug?)
```

## Remember

- Review staged changes first
- Follow conventional format
- Ask for confirmation
- Keep messages concise