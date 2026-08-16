---
title: Command Reference
description: Quick reference for all Knowns CLI commands
createdAt: '2026-02-24T08:44:32.957Z'
updatedAt: '2026-08-13T19:08:48.316Z'
tags: []
---

# Command Reference

Quick reference for Knowns CLI commands. Full docs: `./docs/commands.md`

## Task Commands

```bash
# View
knowns task <id> --plain
knowns task list --plain
knowns task list --status in-progress --plain

# Create
knowns task create "Title" -d "Description" --ac "Criterion" -l "labels"

# Edit
knowns task edit <id> -s in-progress -a @me
knowns task edit <id> --check-ac 1       # Check AC
knowns task edit <id> --plan "1. Step"   # Set plan
knowns task edit <id> --append-notes "Progress"
```

## Doc Commands

```bash
# View
knowns doc <path> --plain
knowns doc list --plain
knowns doc <path> --smart --plain        # Auto-handle large docs
knowns doc <path> --section "2" --plain  # Specific section

# Create/Edit
knowns doc create "Title" -d "Description" -f "folder"
knowns doc edit "path" -c "New content"
knowns doc edit "path" -a "Appended"
```

## Search Commands

```bash
knowns search "query" --plain
knowns search "query" --type task --plain
knowns search "query" --type doc --plain
knowns search index                       # Queue semantic indexing
knowns search index --wait                # Install/start managed Qdrant and block through a validated generation swap
knowns search --reindex                   # Legacy alias for rebuilding semantic index vectors
knowns search --status-check              # Check provider/model/index readiness
knowns qdrant install                     # Install the pinned, checksum-verified managed Qdrant binary
knowns qdrant purge                       # Explicit hard purge of positively owned collections
```

`knowns search index --wait` is the deterministic setup path: in managed mode it installs the pinned Qdrant release when necessary, starts the managed runtime, rebuilds a next-generation collection from canonical Knowns sources, validates it, and activates the pointer only after success. Ordinary search remains non-blocking and falls back to keyword/BM25 while bootstrap is queued.

Existing `.knowns/.search/index.db` vector indexes are migration triggers and temporary fallback only; Qdrant generations are rebuilt from canonical task, doc, memory, and decision sources rather than copying SQLite rows.

`knowns qdrant purge` bypasses rollback retention for privacy deletion, but fails closed unless the active pointer and generation history positively prove that the current store owns every target collection. `knowns doctor` remains read-only and only reports remediation commands.

`knowns search --status-check` reports the configured semantic provider, embedding model, dimensions, active vector backend, indexed model identity, chunk counts, and stale/degraded index reasons when available.

## Time Commands

```bash
knowns time start <id>
knowns time stop
knowns time status
knowns time report --from "2025-01-01"
```

## Template Commands

```bash
knowns template list
knowns template run <name> --name "X"
knowns template create <name>
```

## Model Commands

```bash
knowns model list
knowns model download <name>
knowns model remove <name>
```

## Other Commands

### Diagnose Project Health

Run `knowns doctor` before starting work, especially after cloning a repository that already contains `.knowns/`.

```bash
knowns doctor
knowns doctor --verbose
knowns doctor --plain
knowns doctor --json
knowns doctor --scope project,lsp
knowns doctor --scope search --scope runtime
knowns doctor --strict --json
knowns doctor --online
```

`knowns doctor` is read-only and offline by default. It checks the active project, validation, semantic search and indices, managed runtimes, configured or detected language servers, configured AI artifacts, and Knowns runtime-memory hooks. Registered online checks are returned as `skip` with `online_disabled` until `--online` is explicitly supplied.

For configured or locally available Claude Code, Codex, Kiro, and OpenCode runtimes, missing, disabled, or out-of-sync hooks produce a warning with `knowns runtime install <runtime>` remediation.

| Flag | Description |
|------|-------------|
| `--verbose` | Include passing and skipped checks; default human output shows only warnings and failures |
| `--strict` | Return exit code 1 for a degraded verdict without changing the verdict |
| `--online` | Opt into bounded version and configured-provider connectivity probes |
| `--scope <scope>` | Restrict checks; repeat the flag or use comma-separated values |
| `--plain` | Emit ANSI-free text for agents, logs, and pipes |
| `--json` | Emit the complete versioned diagnostic result |

Initial scopes are `project`, `validation`, `search`, `runtime`, `lsp`, `ai`, and `online`. Unknown scopes are usage errors.

Verdicts and exit codes:

- `healthy`: no warnings or failures; exit 0.
- `degraded`: one or more warnings and no failures; exit 0, or 1 with `--strict`.
- `unhealthy`: one or more failures; exit 1.
- Diagnostic engine or usage failure: exit 2.
- A missing active project is a valid `unhealthy` result with `knowns init` remediation, not an engine failure.

Every warning or failure includes a remediation description and an exact Knowns command when one is safely available. Doctor never executes that command, downloads a model, rebuilds an index, starts or stops a process, synchronizes artifacts, or writes an update cache. The versioned behavior is specified by @doc/specs/2026-07-25/knowns-doctor.

### Additional Commands

```bash
knowns validate                          # Check broken refs
knowns validate --sdd                    # SDD validation
knowns import sync                       # Sync imports
knowns agents sync                       # Sync AI guidelines
knowns browser                           # Open Web UI
```


### Status and Runtime Command Selection

Use the narrowest status surface for the question you are answering:

| Intent | Command |
|--------|---------|
| Project readiness summary | `knowns status` |
| Diagnostic findings and remediation | `knowns doctor` |
| Live shared runtime processes, clients, queue, semantic provider identity, reload generation, and recent job activity | `knowns runtime ps` |
| Compact runtime summary with more client/failure rows | `knowns runtime ps --clients 10 --failures 5` |
| Detailed runtime job history | `knowns runtime ps --jobs --tail 20` |
| Failed runtime jobs only | `knowns runtime ps --failed` |
| Reload cached semantic providers after provider/model config changes | `knowns runtime reload` |
| Wait until the daemon acknowledges a semantic runtime reload | `knowns runtime reload --wait` |
| Runtime hook/plugin/native integration install state | `knowns runtime status` |
| Semantic search provider/model/index details | `knowns search --status-check` |
| LSP language server inventory | `knowns lsp list` |
| Knowledge/Agent daemon lifecycle | `knowns daemon status` |
| Raw runtime or MCP logs | `knowns runtime logs` |

`knowns runtime ps` is intentionally compact by default. Use `--clients` and `--failures` to tune compact summary limits. Use `--jobs`, `--tail`, `--failed`, or `--all` when you need event/job history rather than the live process summary.

`knowns runtime reload` asks the shared runtime daemon to unload cached semantic providers. The next runtime job, search, or semantic session re-reads current provider, model, and dimension settings without requiring a manual process kill. Use `knowns runtime reload --wait` when you need confirmation that the running daemon acknowledged the reload before continuing.

Reloading semantic providers does not rebuild existing vectors. After changing provider, model, or dimensions, compare `knowns runtime ps` with `knowns search --status-check`; if the index is stale or degraded, run `knowns search --reindex`.
