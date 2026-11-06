---
id: doc-a4babba5fc1be309c05640f12323c930
title: Release Process
createdAt: '2026-01-06T07:55:21.590Z'
updatedAt: '2026-03-08T18:19:26.454Z'
description: Guide for releasing new versions of Knowns CLI
tags:
  - release
  - versioning
  - guide
---
# Release Process

Guide for releasing new versions of Knowns CLI.

## Overview

GitHub Releases is the **single source of truth** for changelogs.

```
PRs merged → Release Drafter creates draft
                    │
                    ▼ (When ready to release)
            GitHub Releases → Edit Draft
                    │
                    ▼
            Set version → Publish
                    │
                    ▼
            CI auto: go build (cross-compile) → publish npm wrappers
```
## Semantic Versioning

We follow [SemVer](https://semver.org/): `MAJOR.MINOR.PATCH`

| Change Type | Version Bump | Example |
|-------------|--------------|---------|
| Breaking changes | MAJOR | 0.6.0 → 1.0.0 |
| New features | MINOR | 0.6.0 → 0.7.0 |
| Bug fixes | PATCH | 0.6.0 → 0.6.1 |

## Release Drafter

PRs are auto-categorized based on title prefix:

| Prefix | Category | Version |
|--------|----------|---------|
| `feat:` | Added | Minor |
| `fix:` | Fixed | Patch |
| `docs:` | Documentation | Patch |
| `feat!:` | Breaking Changes | Major |

## Release Steps

### 1. Check Draft Release

Go to: https://github.com/knowns-dev/knowns/releases

### 2. Edit Draft

- Click on the draft release
- Review auto-generated notes
- Edit if needed

### 3. Set Version

- Tag: `v0.7.0`
- Title: `v0.7.0`

### 4. Publish

Click **"Publish release"**

### 5. Automatic Actions

CI will automatically:
- Cross-compile Go binaries for all platforms (linux, darwin, windows / amd64, arm64)
- Create platform-specific npm wrapper packages (`@knowns/cli-<platform>`)
- Publish the `knowns` npm package (which installs the correct binary)
- Upload binary artifacts to the GitHub Release
## Viewing Changelog

All release notes are on GitHub:
https://github.com/knowns-dev/knowns/releases

## Hotfix Process

```bash
# 1. Create hotfix branch
git checkout main && git pull
git checkout -b fix/hotfix-description

# 2. Fix and commit
git commit -m "fix: urgent bug fix"

# 3. Create PR, get review, merge

# 4. Release immediately as patch
```

## Pre-release (Beta)

1. Edit draft release
2. Check **"Set as a pre-release"**
3. Tag as: `v0.7.0-beta.1`
4. Publish

## Checklist

Before releasing:

- [ ] All CI checks pass on main
- [ ] Draft release notes reviewed
- [ ] Version number is correct
- [ ] No known critical bugs
