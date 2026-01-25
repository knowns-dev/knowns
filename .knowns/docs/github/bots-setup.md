---
title: GitHub Bots Setup
createdAt: '2026-01-06T07:54:55.826Z'
updatedAt: '2026-01-06T07:55:11.958Z'
description: Configuration and setup guide for GitHub bots and automation
tags:
  - github
  - bots
  - automation
  - setup
---
# GitHub Bots Setup

All GitHub bots and automation configured for this project.

## Installed Bots

### Issue & PR Management

| Bot | Function | Config |
|-----|----------|--------|
| **Stale** | Auto-close inactive issues/PRs | `.github/workflows/stale.yml` |
| **Welcome** | Greet new contributors | `.github/config.yml` |
| **Request-Info** | Ask for more details | `.github/config.yml` |
| **WIP** | Block merge if title has WIP | `.github/config.yml` |

### Automation

| Bot | Function | Config |
|-----|----------|--------|
| **Dependabot** | Auto update dependencies | `.github/dependabot.yml` |
| **Release Drafter** | Auto generate release notes | `.github/release-drafter.yml` |
| **Auto-Assign** | Auto assign reviewers | `.github/config.yml` |

### Community

| Bot | Function | Config |
|-----|----------|--------|
| **All Contributors** | Recognize contributors | `.all-contributorsrc` |
| **First Timers** | Create beginner-friendly issues | `.github/config.yml` |
| **Sentiment Bot** | Detect toxic comments | `.github/config.yml` |

## Config Files

```
.github/
├── config.yml              # Welcome, Request-Info, Auto-Assign, WIP, Sentiment
├── dependabot.yml          # Dependabot
├── release-drafter.yml     # Release Drafter config
└── workflows/
    ├── stale.yml           # Stale action
    └── release-drafter.yml # Release Drafter action

.all-contributorsrc         # All Contributors
```

## Stale Bot Settings

- Issues: Stale after 60 days, close after 7 more days
- PRs: Stale after 30 days, close after 14 more days
- Exempt labels: `pinned`, `security`, `bug`, `help wanted`

## Dependabot Settings

- Schedule: Weekly (Monday 09:00 ICT)
- Ecosystems: npm, GitHub Actions
- Auto-label: `dependencies`, `automated`

## Release Drafter

Auto-categorize PRs by title prefix:

| Prefix | Category |
|--------|----------|
| `feat:` | 🚀 New Features |
| `fix:` | 🐛 Bug Fixes |
| `docs:` | 📚 Documentation |
| `chore:` | 🔧 Maintenance |
| `perf:` | ⚡ Performance |

## Installation Links

| Bot | Install URL |
|-----|-------------|
| Welcome | https://github.com/apps/welcome |
| Request-Info | https://github.com/apps/request-info |
| All Contributors | https://github.com/apps/allcontributors |
| First Timers | https://github.com/apps/first-timers |
| Auto-Assign | https://github.com/apps/auto-assign |
| Sentiment Bot | https://github.com/apps/sentiment-bot |
| WIP | https://github.com/apps/wip |

> **Note:** Dependabot, Stale, and Release Drafter run as GitHub Actions (no app install needed).
