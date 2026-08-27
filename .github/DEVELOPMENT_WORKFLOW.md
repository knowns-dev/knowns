# Development Workflow

This document describes the standard development workflow for contributing to Knowns CLI.

## Table of Contents

- [Overview](#overview)
- [1. Create Task/Issue](#1-create-taskissue)
- [2. Start Work & Create Branch](#2-start-work--create-branch)
- [3. Development & Commits](#3-development--commits)
- [4. Push & Create Pull Request](#4-push--create-pull-request)
- [5. Code Review](#5-code-review)
- [6. Merge](#6-merge)
- [7. Post-Merge Cleanup](#7-post-merge-cleanup)
- [8. Release Process](#8-release-process)
- [Quick Reference](#quick-reference)

---

## Overview

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  Issue   │───▶│  Branch  │───▶│    PR    │───▶│  Merge   │───▶│ Release  │
│  / Task  │    │   Dev    │    │  Review  │    │  main    │    │  v0.x.x  │
└──────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘
```

**Key Principles:**
- All changes go through Pull Requests
- `main` branch is always deployable
- Use Conventional Commits for clear history
- CI must pass before merge

---

## 1. Create Task/Issue

### For Maintainers (using Knowns CLI)

```bash
# Create a new task
knowns task create "Add new feature X" \
  -d "Description of what needs to be done" \
  --ac "User can perform action X" \
  --ac "Unit tests cover new functionality" \
  --ac "Documentation is updated" \
  --priority medium \
  -l "feature"

# Output: Created task KN-4F7Q2M: Add new feature X
```

### For External Contributors (GitHub Issues)

1. Go to [Issues](https://github.com/knowns-dev/knowns/issues)
2. Click **"New Issue"**
3. Choose template: **Bug Report** or **Feature Request**
4. Fill in all required fields
5. Submit

**Automated Bots:**
- 🤖 **Welcome Bot** - Greets first-time contributors
- 🤖 **Request-Info Bot** - Asks for more details if needed

---

## 2. Start Work & Create Branch

### Claim the Task

```bash
# Assign to yourself and start timer
knowns task edit <id> -s in-progress -a @me
knowns time start <id>
```

### Create Feature Branch

```bash
# Always start from updated main
git checkout main
git pull origin main

# Create new branch
git checkout -b <type>/task-<id>-<short-description>
```

### Branch Naming Convention

| Type | Pattern | Example |
|------|---------|---------|
| Feature | `feat/task-<id>-description` | `feat/task-KN-4F7Q2M-add-export-command` |
| Bug Fix | `fix/task-<id>-description` | `fix/task-KN-9B3XKD-parsing-error` |
| Documentation | `docs/task-<id>-description` | `docs/task-KN-2QW7VT-update-readme` |
| Refactor | `refactor/task-<id>-description` | `refactor/task-KN-6M1HZP-clean-utils` |
| Performance | `perf/task-<id>-description` | `perf/task-KN-8DK3RN-optimize-search` |
| Chore | `chore/task-<id>-description` | `chore/task-KN-5TY0GC-update-deps` |

---

## 3. Development & Commits

### Commit Message Format

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types:**

| Type | Description | Version Bump |
|------|-------------|--------------|
| `feat` | New feature | Minor |
| `fix` | Bug fix | Patch |
| `docs` | Documentation only | Patch |
| `style` | Code style (formatting) | - |
| `refactor` | Code refactoring | Patch |
| `perf` | Performance improvement | Patch |
| `test` | Adding tests | - |
| `chore` | Maintenance tasks | Patch |
| `ci` | CI/CD changes | - |
| `feat!` or `fix!` | Breaking change | Major |

**Examples:**

```bash
# Simple commit
git commit -m "feat: add --children option to task view"

# With scope
git commit -m "feat(cli): add --children option to task view"

# With body and reference
git commit -m "feat: add --children option to task view

- Show detailed list of child tasks
- Display progress summary with completion count
- Support both shorthand and full command

Refs: #63"

# Breaking change
git commit -m "feat!: change task ID format

BREAKING CHANGE: Task IDs now use UUID instead of numeric IDs"
```

### During Development

```bash
# Check your changes
git status
git diff

# Stage and commit frequently
git add <files>
git commit -m "feat: description"

# Keep branch updated with main
git fetch origin
git rebase origin/main
```

---

## 4. Push & Create Pull Request

### Push Your Branch

```bash
git push -u origin <branch-name>

# Example:
git push -u origin feat/task-KN-4F7Q2M-add-export-command
```

### Create Pull Request

1. Go to GitHub repository
2. Click **"Compare & pull request"** (or go to Pull Requests → New)
3. Fill in the PR template:

```markdown
## Description
Brief description of changes

## Related Issue
Fixes #63

## Type of Change
- [x] New feature
- [ ] Bug fix
- [ ] Documentation update

## Checklist
- [x] My code follows the project's style guidelines
- [x] I have added tests
- [x] All tests pass
- [x] I have updated documentation
```

4. Set labels (or let Release Drafter auto-label)
5. Click **"Create Pull Request"**

### PR Title Format

Use Conventional Commits format:

```
feat: add --children option to task view
fix: resolve escape sequence parsing issue
docs: update development workflow guide
```

**Automated Actions:**
- 🤖 **Auto-Assign** - Assigns reviewers automatically
- 🤖 **Release Drafter** - Adds labels based on PR title
- 🤖 **WIP Bot** - Blocks merge if title contains "WIP"
- ⚙️ **CI** - Runs lint, tests, and build

---

## 5. Code Review

### Review Process

```
PR Created
    │
    ▼
┌─────────────────────────────────────┐
│         CI Pipeline Running         │
│  • Lint check                       │
│  • Unit tests                       │
│  • Build verification               │
└─────────────────────────────────────┘
    │
    ├── ❌ CI Failed → Fix issues → Push → CI runs again
    │
    ▼
┌─────────────────────────────────────┐
│         Awaiting Review             │
│  • Code quality                     │
│  • Logic correctness                │
│  • Test coverage                    │
│  • Documentation                    │
└─────────────────────────────────────┘
    │
    ├── 💬 Changes Requested → Address feedback → Push → Re-review
    │
    ▼
┌─────────────────────────────────────┐
│            Approved ✅              │
└─────────────────────────────────────┘
    │
    ▼
    Ready to Merge
```

### Responding to Review

```bash
# Make requested changes
git add <files>
git commit -m "fix: address review feedback"
git push
```

### Review Checklist (for Reviewers)

- [ ] Code follows project conventions
- [ ] Logic is correct and efficient
- [ ] Tests cover new/changed functionality
- [ ] No security vulnerabilities
- [ ] Documentation is updated
- [ ] Commit messages are clear

---

## 6. Merge

### Merge Requirements (Ruleset)

Before merging, ensure:

- ✅ CI pipeline passes
- ✅ At least 1 approval from reviewer
- ✅ No "WIP" in PR title
- ✅ Branch is up to date with `main`
- ✅ All conversations resolved

### Merge Strategy

We use **Squash and Merge**:

```
Feature branch:
  commit 1: "wip: start feature"
  commit 2: "fix: typo"
  commit 3: "feat: complete feature"
        │
        │ [Squash & Merge]
        ▼
main: ──●── "feat: add --children option (#63)"
```

**Benefits:**
- Clean, linear history on `main`
- Each feature = one commit
- Easy to revert if needed

### How to Merge

1. Ensure all checks pass ✅
2. Click **"Squash and merge"**
3. Edit commit message if needed (should match PR title)
4. Click **"Confirm squash and merge"**

---

## 7. Post-Merge Cleanup

### Automated Cleanup

- 🤖 **Delete Merged Branch** - Automatically deletes the feature branch
- 🤖 **Release Drafter** - Updates draft release notes

### Manual Cleanup

```bash
# Update task status
knowns time stop
knowns task edit <id> -s done
knowns task edit <id> --append-notes "Merged in PR #XX"

# Update local repository
git checkout main
git pull origin main

# Delete local branch
git branch -d feat/task-KN-4F7Q2M-add-export-command

# Prune remote tracking branches
git fetch --prune
```

### Complete Task Checklist

```bash
# Verify all acceptance criteria are checked
knowns task <id> --plain

# If not done:
knowns task edit <id> --check-ac 1 --check-ac 2 --check-ac 3
```

---

## 8. Release Process

### When to Release

- After significant features are merged
- After critical bug fixes
- On a regular schedule (e.g., weekly)

### Release Steps

1. **Review Draft Release**
   - Go to [Releases](https://github.com/knowns-dev/knowns/releases)
   - Click on the draft release (auto-generated by Release Drafter)

2. **Verify Release Notes**
   ```markdown
   ## What's Changed

   ### 🚀 New Features
   - Add --children option @user (#63)

   ### 🐛 Bug Fixes
   - Fix escape sequence parsing @user (#64)

   ### 📚 Documentation
   - Update development workflow @user (#65)

   ## Contributors
   @user1, @user2
   ```

3. **Set Version Tag**
   - Follow [Semantic Versioning](https://semver.org/)
   - `v0.7.0` for new features
   - `v0.6.1` for bug fixes
   - `v1.0.0` for breaking changes

4. **Publish Release**
   - Click **"Publish release"**
   - CI will automatically publish to npm

### Version Bumping Guide

| Changes | Version Bump | Example |
|---------|--------------|---------|
| Breaking changes | Major | `0.6.0` → `1.0.0` |
| New features | Minor | `0.6.0` → `0.7.0` |
| Bug fixes, docs | Patch | `0.6.0` → `0.6.1` |

---

## Quick Reference

### Start New Task

```bash
# 1. Claim task
knowns task edit <id> -s in-progress -a @me
knowns time start <id>

# 2. Create branch
git checkout main && git pull
git checkout -b feat/task-<id>-description
```

### During Development

```bash
# Commit changes
git add .
git commit -m "feat: description"

# Push and create PR
git push -u origin <branch>
# → Create PR on GitHub
```

### After Merge

```bash
# Update task
knowns time stop
knowns task edit <id> -s done

# Cleanup
git checkout main && git pull
git branch -d <branch>
```

### Useful Commands

```bash
# View task details
knowns task <id> --plain

# List your tasks
knowns task list --assignee @me --status in-progress --plain

# View task tree
knowns task list --tree --plain

# Search tasks
knowns search "keyword" --type task --plain
```

---

## Related Documentation

- [Contributing Guidelines](CONTRIBUTING.md)
- [Code of Conduct](../CODE_OF_CONDUCT.md)
- [CLI Guidelines](../CLAUDE.md)

---

**Questions?** Open an issue with the `question` label or start a [Discussion](https://github.com/knowns-dev/knowns/discussions).
