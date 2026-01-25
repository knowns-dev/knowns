---
title: Template Import
createdAt: '2026-01-23T04:00:56.684Z'
updatedAt: '2026-01-23T04:02:25.251Z'
description: 'Import templates and docs from external sources (GitHub, NPM, local)'
tags:
  - feature
  - template
  - import
---
## Overview

Import templates và docs từ external sources: GitHub, NPM, local folders.

**Related docs:**
- @doc/templates/overview - Overview
- @doc/templates/config - Configuration

---

## Import Sources

| Source | Format | Example |
|--------|--------|---------|
| **GitHub** | `github:<owner>/<repo>[/path][@ref]` | `github:company/templates/react@v1.0` |
| **Local** | `file:<path>` | `file:../shared-templates` |
| **NPM** | `npm:<package>[@version]` | `npm:@company/templates@latest` |
| **URL** | `https://...` | Direct file URL |

---

## CLI Commands

### `knowns template import`

```bash
# Import từ GitHub repo
knowns template import github:company/templates/react-component

# Import với version tag
knowns template import github:company/templates/react-component@v2.0.0

# Import từ subfolder
knowns template import github:company/knowns-templates/templates/api-endpoint

# Import từ local folder
knowns template import file:../shared-project/.knowns/templates/component

# Import từ NPM
knowns template import npm:@company/knowns-templates/react-component

# Import với custom name
knowns template import github:company/templates/component --as my-component

# Dry run
knowns template import github:company/templates/react --dry-run
```

### `knowns doc import`

```bash
# Import single doc
knowns doc import github:company/standards/docs/api-conventions.md

# Import với custom path
knowns doc import github:company/standards/docs/api-conventions.md \
  --to "conventions/api"

# Import entire docs folder
knowns doc import github:company/standards/docs/ --all

# Import với tag filter
knowns doc import github:company/standards/docs/ --tag "convention"

# Import và link to template
knowns doc import github:company/standards/docs/react-patterns.md \
  --link-template react-component
```

---

## Import Modes

| Mode | Behavior | Command |
|------|----------|---------|
| **copy** (default) | Copy files, can customize | `--mode copy` |
| **link** | Keep reference, auto-sync | `--mode link` |
| **vendor** | Copy & lock, no sync | `--mode vendor` |

```bash
# Copy mode (default)
knowns template import github:company/templates/react

# Link mode - auto-sync when run
knowns template import github:company/templates/react --mode link

# Vendor mode - locked version
knowns template import github:company/templates/react@v1.0.0 --mode vendor
```

---

## Sync Updates

```bash
# Check for updates
$ knowns template sync --check
Templates with updates available:
  - react-component: local v2.0.0 → remote v2.1.0
  - api-endpoint: up to date

# Sync specific template
$ knowns template sync react-component

# Sync all templates
$ knowns template sync --all

# Force sync (overwrite local changes)
$ knowns template sync react-component --force
```

---

## Source Repository Structure

Recommended structure cho template source repo:

```
knowns-templates/                    # Repository root
├── README.md
├── templates/
│   ├── react-component/
│   │   ├── _template.yaml
│   │   └── *.hbs
│   ├── api-endpoint/
│   └── index.json                   # Manifest
├── docs/
│   ├── patterns/
│   └── conventions/
└── knowns.config.json
```

### `templates/index.json` (Manifest)

```json
{
  "version": "1.0.0",
  "templates": [
    {
      "name": "react-component",
      "path": "react-component",
      "description": "React functional component",
      "tags": ["react", "frontend"],
      "linkedDoc": "../docs/patterns/react-component.md"
    }
  ]
}
```

---

## Local Overrides

Sau khi import, có thể override mà không mất sync:

```yaml
# _template.yaml

_source:
  type: github
  repo: company/templates
  path: react-component
  ref: v2.0.0

# Inherited from source
name: react-component
prompts: [...from source...]

---
# LOCAL OVERRIDES (preserved on sync)
_overrides:
  prompts:
    - name: projectPrefix
      type: text
      message: "Project prefix?"
  destination: src/ui/components
```

---

## Authentication

Cho private repos:

```bash
# Set GitHub token
knowns config set github.token <token>

# Or environment variable
export KNOWNS_GITHUB_TOKEN=<token>

# Import from private repo
knowns template import github:company/private-templates/react
```

---

## Use Cases

### Organization Standards

```bash
# Central standards repo
github:company/engineering-standards

# Each project imports
knowns template import github:company/engineering-standards/templates/api-endpoint
knowns doc import github:company/engineering-standards/docs/conventions/
```

### Team Sharing

```bash
# Team templates repo
knowns template import github:team/templates/feature-module
```

### Monorepo

```bash
# Import from sibling package
knowns template import file:../../packages/templates/.knowns/templates/component
```

---

## Security

| Risk | Mitigation |
|------|------------|
| Malicious templates | Review before import |
| Secrets in templates | Never commit secrets |
| Breaking changes | Use version tags |

```bash
# Always review before import
knowns template import github:unknown/template --dry-run

# Use specific versions
knowns template import github:company/templates/api@v1.2.3
```
