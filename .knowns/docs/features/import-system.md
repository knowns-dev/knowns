---
title: Import System
createdAt: '2026-01-25T12:07:26.279Z'
updatedAt: '2026-01-25T13:18:59.650Z'
description: >-
  Import and sync templates/docs from external sources (git, npm, local,
  registry)
tags:
  - feature
  - templates
  - docs
  - import
  - sync
---
# Import System

Import and sync templates/docs from external sources (git, npm, local paths, or registry).

## 1. Overview

The Import System allows projects to:
- **Import once**: Copy templates/docs into the project
- **Sync on demand**: Keep imported content updated with sources
- **Multiple sources**: Git repos, npm packages, local paths, central registry

### Requirements

**Source must have `.knowns/` directory** containing templates or docs. If the source doesn't have a `.knowns/` folder, the import will fail with an error.

```
source-repo/
├── .knowns/           # REQUIRED
│   ├── templates/     # Templates to import
│   └── docs/          # Docs to import
└── ...
```

### Use Cases

| Scenario | Solution |
|----------|----------|
| Share templates across team projects | Git repo with `knowns sync` |
| Use community templates | Registry or npm package |
| Copy from another local project | Local path import |
| Organization-wide patterns | Private npm package |
## 2. Import Sources

### 2.1 Git Repository

```bash
# Import from public repo
knowns import https://github.com/org/shared-templates.git

# Import from private repo (uses git credentials)
knowns import git@github.com:org/private-templates.git

# Import specific branch/tag
knowns import https://github.com/org/templates.git --ref v1.0.0
knowns import https://github.com/org/templates.git --ref main

# Import specific paths only
knowns import https://github.com/org/templates.git --include "templates/*" --include "docs/patterns/*"
```

### 2.2 npm Package

```bash
# Import from public npm
knowns import @org/templates

# Import specific version
knowns import @org/templates@1.2.0

# Import from private registry
knowns import @org/templates --registry https://npm.company.com
```

### 2.3 Local Path

```bash
# Import from sibling project
knowns import ../other-project/.knowns

# Import specific folders
knowns import ~/shared-templates --include "templates/*"

# Import with symlink (for development)
knowns import ../shared --link
```

### 2.4 Registry (Future)

```bash
# Browse available templates
knowns browse

# Import from Knowns registry
knowns import knowns://react-component
knowns import knowns://api-endpoint@2.0
```

## 3. Configuration

Imports are configured in `.knowns/config.json`:

```json
{
  "imports": [
    {
      "name": "shared-templates",
      "source": "https://github.com/org/shared-templates.git",
      "type": "git",
      "ref": "main",
      "include": ["templates/*", "docs/patterns/*"],
      "exclude": ["docs/internal/*"],
      "autoSync": false
    },
    {
      "name": "company-patterns",
      "source": "@company/patterns",
      "type": "npm",
      "version": "^1.0.0"
    },
    {
      "name": "local-shared",
      "source": "../shared-knowns",
      "type": "local",
      "link": true
    }
  ]
}
```

### Config Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Unique identifier for this import |
| `source` | string | URL, package name, or path |
| `type` | enum | `git`, `npm`, `local`, `registry` |
| `ref` | string | Git branch/tag (git only) |
| `version` | string | npm version range (npm only) |
| `include` | string[] | Glob patterns to include |
| `exclude` | string[] | Glob patterns to exclude |
| `autoSync` | boolean | Auto-sync on `knowns sync` |
| `link` | boolean | Symlink instead of copy (local only) |

## 4. CLI Commands

### Import Command

```bash
# Basic import
knowns import <source>

# Options
knowns import <source> \
  --name <name>           # Custom name for this import
  --type <type>           # Force source type
  --ref <ref>             # Git ref (branch/tag)
  --include <pattern>     # Include patterns (repeatable)
  --exclude <pattern>     # Exclude patterns (repeatable)
  --link                  # Symlink (local only)
  --no-save               # Don't save to config
```

### Sync Command

```bash
# Sync all imports
knowns sync

# Sync specific import
knowns sync shared-templates

# Sync with options
knowns sync --force        # Overwrite local changes
knowns sync --dry-run      # Preview changes
knowns sync --prune        # Remove deleted files
```

### List Imports

```bash
# Show configured imports
knowns import list

# Output:
# NAME              TYPE   SOURCE                              STATUS
# shared-templates  git    github.com/org/shared-templates     ✓ synced
# company-patterns  npm    @company/patterns@1.2.0             ⚠ outdated
# local-shared      local  ../shared-knowns                    → linked
```

### Remove Import

```bash
# Remove import (keeps files)
knowns import remove shared-templates

# Remove import and delete files
knowns import remove shared-templates --delete
```

## 5. Import Behavior

### 5.1 Validation

**Before importing, the system validates:**

1. Source is accessible (git clone, npm install, path exists)
2. **Source has `.knowns/` directory** - if not, error:
   ```
   Error: Source does not contain .knowns/ directory
   Hint: Only Knowns-enabled projects can be imported
   ```
3. `.knowns/` contains at least one of: `templates/`, `docs/`

### 5.2 Directory Structure

Imported content goes to `.knowns/imports/<name>/`:

```
.knowns/
├── config.json          # Import configuration
├── imports/
│   ├── shared/          # Import name: "shared"
│   │   ├── .import.json # Import metadata
│   │   ├── templates/
│   │   │   └── react-component/
│   │   └── docs/
│   │       └── patterns/
│   └── company/
│       └── templates/
├── templates/           # Local templates (editable)
└── docs/                # Local docs (editable)
```

### 5.3 Referencing Imported Content

Import name is used as folder prefix in references:

| Location | Reference |
|----------|-----------|
| `.knowns/docs/readme.md` | `@doc/readme` |
| `.knowns/docs/patterns/auth.md` | `@doc/patterns/auth` |
| `.knowns/imports/shared/docs/patterns/api.md` | `@doc/shared/patterns/api` |
| `.knowns/imports/company/docs/guides/setup.md` | `@doc/company/guides/setup` |

**Templates:**

| Location | Reference |
|----------|-----------|
| `.knowns/templates/component` | `@template/component` |
| `.knowns/imports/shared/templates/form` | `@template/shared/form` |

### 5.4 Editing Imported Content

**Imported content IS editable.** Users can modify imported files directly.

However, when syncing:
- **Modified files are skipped** to preserve local changes
- User is notified about skipped files
- Use `--force` to overwrite local modifications

```bash
$ knowns sync shared

Syncing import: shared
  ✓ docs/patterns/api.md (updated)
  ✓ templates/component/_template.yaml (updated)
  ⚠️ docs/patterns/auth.md (skipped - local modifications)
  ⚠️ templates/form/_template.yaml (skipped - local modifications)

Sync complete: 2 updated, 2 skipped (locally modified)
Hint: Use --force to overwrite local modifications
```

### 5.5 Metadata File

Each import has `.import.json` with file hashes for change detection:

```json
{
  "name": "shared",
  "source": "https://github.com/org/shared-templates.git",
  "type": "git",
  "importedAt": "2025-01-25T10:30:00Z",
  "lastSync": "2025-01-25T10:30:00Z",
  "ref": "main",
  "commit": "abc123",
  "files": [
    "templates/react-component/_template.yaml",
    "docs/patterns/component-pattern.md"
  ],
  "fileHashes": {
    "templates/react-component/_template.yaml": "a1b2c3d4",
    "docs/patterns/component-pattern.md": "e5f6g7h8"
  }
}
```

### 5.6 Resolution Order

When a doc/template is requested:

1. **Local first** - `.knowns/docs/` or `.knowns/templates/`
2. **Then imports** - `.knowns/imports/*/docs/` or `*/templates/`

If same path exists in local AND import, **local wins**.

### 5.7 Conflict Handling

| Scenario | Default Behavior | Override |
|----------|------------------|----------|
| Import file modified locally | Warn, skip | `--force` |
| Local file exists at same path | Local takes precedence | - |
| Source file deleted | Keep local | `--prune` |
| Name collision (import name) | Error | `--name <unique>` |
| No .knowns/ in source | **Error** | - |
## 6. Web UI

### Import Manager

Access via sidebar: **Settings > Imports** or `#/settings/imports`

Features:
- View configured imports
- Add new import (form)
- Sync individual or all imports
- View sync status and history
- Remove imports

### Browse Templates (Future)

Access via: **Templates > Browse** or `knowns browse`

- Search registry for templates
- Preview before import
- One-click import

## 7. API Endpoints

### List Imports

```
GET /api/imports
Response: { imports: ImportConfig[], count: number }
```

### Add Import

```
POST /api/imports
Body: { source, type?, name?, include?, exclude?, ref?, version? }
Response: { success: true, import: ImportConfig }
```

### Sync Import

```
POST /api/imports/:name/sync
Body: { force?: boolean, prune?: boolean, dryRun?: boolean }
Response: { success: true, changes: Change[] }
```

### Remove Import

```
DELETE /api/imports/:name
Query: ?delete=true (to delete files)
Response: { success: true }
```

## 8. Examples

### Team Shared Templates

```bash
# Team lead creates shared repo
# Contains: templates/react-component, templates/api-endpoint, docs/patterns/*

# Each project imports
knowns import https://github.com/team/shared-knowns.git --name team

# Update all projects
knowns sync team
```

### Organization Patterns via npm

```bash
# Publish @myorg/knowns-patterns to npm
# Contains standard templates and documentation

# Projects install
knowns import @myorg/knowns-patterns

# Update when new version released
knowns sync
```

### Local Development Workflow

```bash
# Developer working on shared templates
cd ~/projects/shared-knowns
# Make changes...

# Test in project (linked)
cd ~/projects/my-app
knowns import ../shared-knowns --link --name dev-shared

# Changes reflect immediately (symlink)
```

## 9. Security Considerations

- Git imports use user's git credentials
- npm imports use user's npm auth
- No automatic code execution from imports
- Templates are validated before use
- `.import.json` tracks provenance

## 10. Future Enhancements

- [ ] Knowns Registry (central hub)
- [ ] Template versioning
- [ ] Dependency resolution between templates
- [ ] Auto-sync via git hooks
- [ ] Import from GitHub Gist
- [ ] Template ratings/reviews in registry
