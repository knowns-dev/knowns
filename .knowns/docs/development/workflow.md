---
title: Development Workflow
createdAt: '2026-01-06T07:54:31.774Z'
updatedAt: '2026-01-06T07:54:47.956Z'
description: >-
  Complete guide for the development process including branching, PR, merge and
  release
tags:
  - workflow
  - contributing
  - guide
---
# Development Workflow

Complete guide for contributing to Knowns CLI.

## Overview

```
Issue/Task → Branch → Code → PR → CI ✅ → Review ✅ → Merge → Release
```

## 1. Create Task

```bash
# Maintainers: Use Knowns CLI
knowns task create "Feature title" \
  -d "Description" \
  --ac "Acceptance criterion 1" \
  --ac "Acceptance criterion 2" \
  --priority medium \
  -l "feature"

# External: Create GitHub Issue
```

## 2. Start Work

```bash
# Claim task
knowns task edit <id> -s in-progress -a @me
knowns time start <id>

# Create branch
git checkout main && git pull
git checkout -b feat/task-<id>-description
```

### Branch Naming

| Type | Pattern |
|------|---------|
| Feature | `feat/task-<id>-description` |
| Bug Fix | `fix/task-<id>-description` |
| Docs | `docs/task-<id>-description` |
| Refactor | `refactor/task-<id>-description` |

## 3. Commit

Use Conventional Commits:

```bash
git commit -m "feat: add new feature"
git commit -m "fix: resolve bug"
git commit -m "docs: update readme"
```

| Type | Description |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation |
| `refactor` | Code refactoring |
| `perf` | Performance |
| `test` | Tests |
| `chore` | Maintenance |

## 4. Create PR

```bash
git push -u origin <branch>
# Then create PR on GitHub
```

**PR Title:** Use Conventional Commits format
- `feat: add --children option`
- `fix: escape sequence parsing`

## 5. Code Review

Requirements:
- ✅ CI passes (lint, test, build)
- ✅ 1+ approval
- ✅ No "WIP" in title
- ✅ Branch up to date

## 6. Merge

Use **Squash and Merge** strategy.

## 7. After Merge

```bash
# Complete task
knowns time stop
knowns task edit <id> -s done

# Cleanup
git checkout main && git pull
git branch -d <branch>
```

## 8. Release

1. Go to GitHub Releases
2. Edit draft (auto-generated)
3. Set version tag
4. Publish

## Quick Reference

```bash
# Start task
knowns task edit <id> -s in-progress -a @me
knowns time start <id>
git checkout -b feat/task-<id>-desc

# Finish task
knowns time stop
knowns task edit <id> -s done
git checkout main && git pull
```
