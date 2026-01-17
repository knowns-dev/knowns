---
name: knowns.commit
description: Use when committing code changes with proper conventional commit format and verification
---

# Committing Changes

Create well-formatted commits following conventional commit standards.

**Announce at start:** "I'm using the knowns.commit skill to commit changes."

**Core principle:** VERIFY BEFORE COMMITTING - run tests, check lint.

## The Process

### Step 1: Review Changes

```bash
# Check status
git status

# View changes
git diff --stat
git diff
```

### Step 2: Verify Quality

**Before committing, verify:**

```bash
# Tests pass
npm test  # or pytest, etc.

# Lint clean
npm run lint

# Build succeeds (if applicable)
npm run build
```

**Don't commit if any verification fails.**

### Step 3: Stage Changes

```bash
# Stage specific files
git add <files>

# Or stage all
git add .
```

**Never commit:**
- Secrets (.env, credentials)
- Build artifacts
- Large binary files

### Step 4: Draft Commit Message

**Conventional commit format:**
```
<type>(<scope>): <description>

<body>
```

**Types:**
| Type | Use for |
|------|---------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `style` | Formatting, no code change |
| `refactor` | Code restructuring |
| `perf` | Performance improvement |
| `test` | Adding tests |
| `chore` | Maintenance |

### Step 5: Ask for Confirmation (REQUIRED)

**Present the commit message to user and ASK:**

```
Ready to commit with this message:

feat(auth): add JWT token refresh

- Added refresh token endpoint
- Tokens expire after 1 hour
- Automatic refresh before expiry

Proceed with commit? (yes/no/edit)
```

**Wait for user approval before executing git commit.**

### Step 6: Commit (after approval)

```bash
git commit -m "$(cat <<'EOF'
feat(auth): add JWT token refresh

- Added refresh token endpoint
- Tokens expire after 1 hour
- Automatic refresh before expiry
EOF
)"
```

### Step 7: Verify Commit

```bash
git log -1
git show --stat
```

## Commit Message Guidelines

**Good:**
- `feat(api): add user profile endpoint`
- `fix(auth): handle expired token gracefully`
- `docs(readme): update installation steps`

**Bad:**
- `update code` (too vague)
- `WIP` (not ready to commit)
- `fix bug` (which bug?)

## When to Stop

**Don't commit if:**
- Tests are failing
- Lint errors exist
- Build is broken
- Changes are incomplete

**Fix issues first, then commit.**

## Remember

- Verify before committing (tests, lint)
- Ask user for confirmation before commit
- Use conventional commit format
- Keep commits focused and atomic
- Never commit secrets
