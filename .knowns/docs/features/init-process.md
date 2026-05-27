---
title: Init Process
description: Detailed init wizard flow and configuration steps
createdAt: '2026-01-23T04:13:12.738Z'
updatedAt: '2026-05-27T16:26:40.802Z'
tags: []
---

## Overview

## Overview

`knowns init` is an interactive wizard to set up Knowns in a project. Written in Go using the Cobra CLI framework, the init command guides users through project configuration and then executes post-wizard steps with progressive animation.

> **Note:** Since v0.22, `knowns init` focuses only on project structure, git tracking, and semantic search setup. AI integration files (instructions, MCP configs, skills) are now handled by the separate `knowns setup` command.

**Key technologies:**
- **Cobra** (`github.com/spf13/cobra`) — CLI command framework
- **huh** (`github.com/charmbracelet/huh`) — Interactive wizard forms (Catppuccin theme)
- **bubbletea** (`charm.land/bubbletea/v2`) — Download progress bars
- **Goroutine spinner** — Task step animation (avoids terminal escape sequence issues)

**Source files:**
- `internal/cli/init.go` — Main init command, wizard form, config types
- `internal/cli/init_steps.go` — Progressive step runner, goroutine spinner
- `internal/cli/download_setup.go` — Download steps with bubbletea progress bars
- `internal/cli/setup.go` — AI platform setup command (separate from init)

---

## Quick Start

```bash
# Interactive (full wizard)
knowns init

# Quick init with defaults (skip wizard)
knowns init my-project --no-wizard

# Force reinitialize
knowns init --force
```

---

## Wizard Flow

The wizard uses the `huh` library to present form groups sequentially. Each group appears one at a time. Groups can be conditionally hidden based on previous answers.

When running `knowns init --force`, all fields are pre-populated from existing `config.json` values so the user can just Enter through to keep current settings or change any option.

```
┌─────────────────────────────────────────────────────────┐
│                  knowns init                             │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│ Group 1: Project Name                                   │
│ • Project name (text input)                             │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│ Group 1b: Git Tracking (if in git repo, not set by flag)│
│ • Git tracking mode (select)                            │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│ Group 2: AI Platforms                                   │
│ • AI platforms to integrate (multi-select)              │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│ Group 3: Chat UI                                        │
│ • Enable Chat UI? (confirm)                             │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│ Group 4: Auto-sync                                      │
│ • Auto-sync skills on update? (confirm)                 │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│ Group 5: Semantic Search                                │
│ • Enable semantic search? (confirm)                     │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│ Group 6: Model Selection (hidden if semantic disabled)  │
│ • Select embedding model (select)                       │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│ Post-Wizard: Progressive Step Animation                 │
│ • Create project structure       ✓                      │
│ • Apply settings                 ✓                      │
│ • Configure git integration      ✓                      │
│ • Download ONNX Runtime          ⠋ (progress bar)       │
│ • Download model files           ○ (pending)            │
│ • Sync skills                    ○                      │
│ • Create MCP config              ○                      │
│ • Create instruction files       ○                      │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│ Done! Show get-started hints                            │
└─────────────────────────────────────────────────────────┘
```

### Pre-population on --force

When `knowns init --force` is used, the wizard reads existing `config.json` and pre-populates:
- Project name
- Git tracking mode (selected option matches current setting)
- AI platforms
- Chat UI enabled/disabled
- Auto-sync enabled/disabled
- Semantic search enabled/disabled
- Embedding model

### Git Tracking: config.json always committed

Both `git-tracked` and `git-ignored` modes allow `config.json` to be pushed to git. This enables `knowns sync` after cloning.

`git-ignored` mode generates:
```
.knowns/*
!.knowns/config.json
!.knowns/docs/
!.knowns/docs/**
!.knowns/templates/
!.knowns/templates/**
```

---
## Group 1: Project Setup

```
? Project name: (my-project)
  # Default: current directory name

? Git tracking mode:
  > Git Tracked (recommended for teams)
    Git Ignored (personal use)
    None (ignore all)
```

The git tracking select field only appears if the current directory is a git repository AND neither `--git-tracked` nor `--git-ignored` flags were provided.

**Config struct:**
```go
type initConfig struct {
    Name             string
    GitTrackingMode  string   // "git-tracked" | "git-ignored" | "none"
    EnableSemantic   bool
    SemanticModel    string
}
```

---

## Group 2: Semantic Search

```
? Enable semantic search?
  Requires embedding model download
  > Yes / No
```

Defaults to `true`. If disabled, Group 3 is hidden and no download steps are added to the post-wizard pipeline.

---

## Group 3: Model Selection

## Post-Wizard Steps (In Order)

### 1. Creating project structure

Creates the `.knowns/` directory tree via `storage.NewStore(root).Init(name)`:

```
.knowns/
├── config.json              # Project config
├── tasks/                   # Task files
├── docs/                    # Documentation
└── templates/               # Code templates
```

### 2. Applying settings

Loads the config created in step 1, then applies wizard answers:
- Sets `gitTrackingMode` from wizard selection
- Sets `gitTracking` per-section toggles (tasks, docs, templates, memories)
- If semantic search is enabled, saves `semanticSearch` settings with model ID, provider, and dimensions

### 3. Configuring git integration

Based on the selected git tracking mode and per-section toggles:

| Mode | Behavior |
|------|----------|
| `git-tracked` | All sections tracked (respects per-section toggles) |
| `git-ignored` | Only sections with `gitTracking.<section>: true` are tracked |
| `none` | Everything in `.knowns/` is ignored |

If semantic search is enabled, `.knowns/search-index/` is always added to `.gitignore`.

### 4. Semantic search downloads (conditional)

Only runs if semantic search was enabled. Three possible outcomes:

- **Already installed**: Shows a single "Semantic search (already installed)" task step
- **Needs download**: Adds download steps for ONNX Runtime and model files
- **Setup failed**: Prints warning and suggests `knowns model download <model>`

Download steps include:
- **ONNX Runtime** (`{os}/{arch}`): Downloaded as `.tgz`, extracted via `postHook` to `~/.knowns/lib/`
- **Model files**: Downloaded from HuggingFace to `~/.knowns/models/{huggingface-id}/`

> **Note:** Steps 5-7 from previous versions (syncing skills, creating MCP config, creating instruction files) have been moved to `knowns setup`. Init no longer generates AI integration files.

---

## Post-Wizard Steps (In Order)

### 1. Creating project structure

Creates the `.knowns/` directory tree via `storage.NewStore(root).Init(name)`:

```
.knowns/
├── config.json              # Project config
├── tasks/                   # Task files
├── docs/                    # Documentation
└── templates/               # Code templates
```

### 2. Applying settings

Loads the config created in step 1, then applies wizard answers:
- Sets `gitTrackingMode` from wizard selection
- If semantic search is enabled, saves `semanticSearch` settings with model ID, HuggingFace ID, dimensions, and max tokens

### 3. Configuring git integration

Based on the selected git tracking mode:

| Mode | .gitignore entries |
|------|-------------------|
| `git-tracked` | (nothing added) |
| `git-ignored` | `.knowns/` |
| `none` | `.knowns/` |

If semantic search is enabled, `.knowns/search-index/` is always added to `.gitignore`.

### 4. Semantic search downloads (conditional)

Only runs if semantic search was enabled. Three possible outcomes:

- **Already installed**: Shows a single "Semantic search (already installed)" task step
- **Needs download**: Adds download steps for ONNX Runtime and model files
- **Setup failed**: Prints warning and suggests `knowns model download <model>`

Download steps include:
- **ONNX Runtime** (`{os}/{arch}`): Downloaded as `.tgz`, extracted via `postHook` to `~/.knowns/lib/`
- **Model files**: Downloaded from HuggingFace to `~/.knowns/models/{huggingface-id}/`

### 5. Syncing skills

Runs `codegen.SyncSkills(cwd)` to generate skill files from embedded templates.

### 6. Creating MCP config

Creates `.mcp.json` in the project root for Claude Code MCP auto-discovery:

```json
{
  "mcpServers": {
    "knowns": {
      "command": "/path/to/knowns",
      "args": ["mcp", "--stdio"]
    }
  }
}
```

The command path is resolved from `os.Executable()`, falling back to `"knowns"`.

### 7. Creating instruction files

Generates agent instruction files for all supported platforms:

| File | Platform |
|------|----------|
| `CLAUDE.md` | Claude Code |
| `GEMINI.md` | Gemini CLI |
| `AGENTS.md` | Generic AI |
| `.github/copilot-instructions.md` | GitHub Copilot |

Each file contains a condensed version of the Knowns guidelines with quick reference commands. Files are skipped if they already exist (unless `--force`).

---

## CLI Options

```bash
knowns init [name] [flags]

# Arguments:
#   name          Project name (default: directory name)

# Flags:
#   --git-tracked     Track .knowns/ files in git
#   --git-ignored     Add .knowns/ to .gitignore
#   --wizard          Run interactive setup wizard (default behavior)
#   --no-wizard       Skip interactive prompts, use defaults
#   -f, --force       Force reinitialize even if already initialized
```

### Non-interactive mode

When `--no-wizard` is passed or a name argument is provided, the wizard is skipped and defaults are used:
- Name: argument value or directory name
- Git tracking: `git-tracked` (unless overridden by flags)
- Semantic search: enabled with `gte-small` model

---

## Config Output

```json
// .knowns/config.json
{
  "name": "my-project",
  "settings": {
    "gitTrackingMode": "git-tracked",
    "semanticSearch": {
      "enabled": true,
      "model": "gte-small",
      "huggingFaceId": "Xenova/gte-small",
      "dimensions": 384,
      "maxTokens": 512
    }
  }
}
```

---

## Complete Example

```bash
$ knowns init

🚀 Knowns Project Setup
   Quick configuration

? Project name: my-awesome-app

? Git tracking mode: Git Tracked (recommended for teams)

? Enable semantic search? Yes

? Select embedding model: gte-small (recommended) — 384 dims, 67MB — best balance

  ✓ Creating project structure
  ✓ Applying settings
  ✓ Configuring git integration
  ⠋ ONNX Runtime (darwin/arm64)
    ▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░ 65%  23MB/35MB  3.2MB/s
  ○ gte-small (recommended) — model.onnx
  ○ gte-small (recommended) — tokenizer.json
  ...

  ✓ Creating project structure
  ✓ Applying settings
  ✓ Configuring git integration
  ✓ ONNX Runtime (darwin/arm64) (35MB)
  ✓ gte-small (recommended) — model.onnx (67MB)
  ✓ gte-small (recommended) — tokenizer.json (712KB)
  ✓ gte-small (recommended) — config.json (1KB)
  ✓ Syncing skills
  ✓ Creating MCP config
  ✓ Creating instruction files

Get started:
  knowns task create "My first task"
  Use /kn-init to start an AI session
```

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Already initialized | Shows warning, exits (use `--force` to override) |
| No git repo | Shows warning but continues |
| User cancels wizard (Ctrl+C) | Shows "Setup cancelled", exits cleanly |
| Download fails | Step shows `✗` with error, init aborts |
| Semantic setup fails | Warns, suggests `knowns model download` |
| File already exists | Skipped (unless `--force`) |

---

## Architecture Notes

### Why two animation strategies?

**Task steps** (creating directories, writing configs) use a simple goroutine spinner that writes to stderr. This avoids the terminal escape sequence leakage (`^[[?2026;2$y`) that can occur when multiple bubbletea programs run in sequence.

**Download steps** use bubbletea because they need richer UI: progress bars, percentage display, speed calculation, and multi-step state management. Consecutive download steps are batched into a single bubbletea program to avoid repeated terminal initialization.

### drainStdin

The `drainStdin()` function in `download_setup.go` reads and discards pending bytes on stdin (non-blocking) between bubbletea programs. This prevents stale terminal escape responses (DECRQM) from leaking into the shell after huh/bubbletea programs exit.

### AI platforms are auto-configured

Unlike the previous Node version which had an AI platform selection step, the Go version automatically generates instruction files for all supported platforms (Claude Code, OpenCode, Gemini CLI, GitHub Copilot, Generic AI) and writes project-level MCP config for Claude Code and OpenCode. This reduces wizard friction since most users want the common AI tooling configured during init.


## Terminal Behavior

The init wizard is optimized for normal interactive terminals, but some terminal conditions affect how it renders:

- **Narrow terminals:** if the terminal is too narrow, Knowns falls back to non-interactive defaults instead of trying to render the full wizard in an unusable layout.
- **Terminal resize during wizard:** the wizard runs in an alternate screen to reduce duplicated lines and redraw artifacts when the terminal is resized while the form is active.
- **Installer output:** third-party installers (for example the OpenCode install script) write directly to the terminal, so their output may still appear verbose or visually noisy even when the rest of the wizard is well-behaved.

This behavior is intentional: prefer a readable fallback over a broken wizard, and isolate the form UI from the main terminal screen when possible.
