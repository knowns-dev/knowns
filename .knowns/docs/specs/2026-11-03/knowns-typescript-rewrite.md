---
id: doc-7c0dbdd40f8c36d3f72dc2c758d3e55b
title: knowns-typescript-rewrite
description: Specification for rewriting Knowns from Go back to TypeScript on Bun
createdAt: '2026-11-02T19:05:28.224Z'
updatedAt: '2026-11-09T18:01:55.403Z'
tags:
  - spec
  - draft
  - review-required
---

## Overview

Rewrite the Knowns CLI, MCP server, and HTTP server from Go back to TypeScript, shipped as one Bun-compiled binary per platform. The React UI (`ui/`) is unchanged and embedded as before.

Why now: the maintainer does not work comfortably in Go, so reviewing ~105k lines of Go (including agent-written changes) is a long-term maintainability risk, and the TypeScript contributor pool is larger. The native pieces that made Go attractive have left the core: embedding is Ollama over HTTP, vectors live in Qdrant over HTTP, and code intelligence runs through LSP instead of tree-sitter.

Explicit non-goal: the rewrite is not expected to fix install failures by itself. Issues #133, #138, #144, #155 come from install scripts and OS handling; they are carried forward as regression tests (FR-9), not assumed away.

Predecessor: @doc/specs/knowns-go-rewrite (the opposite migration, 2026-03).

## Locked Decisions

- D1: Parallel rewrite with a one-time switch. No strangler bridge through the Go binary; the TypeScript build replaces Go only after it meets the release gate (D11).
- D2: The Go code is fully frozen for the duration of the rewrite. Only security fixes are allowed, and each must land with an e2e test the TypeScript build must also pass.
- D3: TypeScript work lives on one long-lived branch in this repository and merges once at the switch. Go code is deleted in that merge.
- D4: Runtime is Bun with `bun build --compile`: one binary per platform, no Node or Bun required on the user's machine. Distribution keeps per-platform npm packages and `install.sh` / `install.ps1`.
- D5: Budgets that block release: on each platform, the binary may exceed an empty Bun-compiled binary for the same target by at most 30MB (Knowns code plus embedded UI); `knowns --version` and MCP readiness each at most 150ms. Revised 2026-11-03 after TSR-5BRB3D measured the stub (raw): darwin 65-70MB, linux 102MB, windows 114-117MB, because the Bun runtime alone is about 100MB on linux and more on windows. The original fixed 100MB limit was unreachable. Go 0.34.1 for reference: 35MB raw, 12MB gzip.
- D6: Full parity of commands, flags, output formats (`--plain`, `--json`), MCP tools and schemas, HTTP endpoints and SSE/WebSocket events, and the `.knowns/` data format. The only exceptions are D7, D8, D13, D14 and the divergences D12 allows.
- D7: `knowns reconcile preview` and `knowns reconcile apply` are removed. `knowns reconcile restore` stays. The automatic reconciler (watcher, history, tombstones, restore) is ported and follows @decision/20260912-1650-a-briefly-missing-file-is-not-a-deletion.
- D8: `knowns import` (list, add, remove, status, sync) is removed. Content already present in `.knowns/imports/` stays readable and searchable; `knowns doctor` reports that import management was removed. The web server keeps the read endpoints of `/api/imports` and drops add, remove and sync; the UI hides those actions (decided 2026-11-06, @task-TSR-0MM0QC).
- D9: Direct switch with no beta channel: the TypeScript build becomes the stable release.
- D10: The TypeScript build ships as v0.35.0. The last Go release (0.34.x) stays installable via `npm i knowns@0.34` and `install.sh --version 0.34.x`. The TypeScript build never writes `.knowns/` data that 0.34.x cannot read. Revised 2026-11-09: the version was v1.0.0. It is v0.35.0 so the first TypeScript release still reads as pre-1.0 while it may carry bugs, and it sorts above 0.34.1 so `knowns update`, the update notice, doctor and `npm update` move Go users onto it (0.9.0 would sort below 0.34.1 and strand them). v1.0.0 follows once 0.35.x is stable.
- D11: Release gate for v0.35.0: the Go e2e suite passes with `TEST_BINARY` pointed at the TypeScript binary on all 6 platforms; OS regression tests (FR-9) pass; UI Playwright e2e passes; and the maintainer has used the TypeScript build on this repository for at least 2 consecutive weeks with no data-loss bug.
- D12: The TypeScript build may differ from 0.34.1 only to fix unsafe behavior, a data-integrity hole or a false success report in 0.34.1. Each divergence is listed under Approved Divergences with its task and a test that fails without the fix, keeps 0.34.1's output and exit code wherever the fix allows, and never breaks D10. Added 2026-11-06. Widened 2026-11-10: a false failure report that leads the user to repeat expensive work (a reindex reported as failed while the runtime job still runs) also qualifies (@task-KN-Q6DVKQ). Usability and performance changes (@task-KN-HDJWY6, @task-KN-V68H43) wait until after v0.35.0.
- D13: v0.35.0 adds contributor PR #156 (tasks by assignee) on top of 0.34.1: `knowns task list --unassigned`, the `knowns task assignees` command (task counts per assignee, broken down by status, taking the same filters as `task list`, with `--plain` and `--json`), the MCP `tasks` list parameter `unassigned`, assignee filters in the CLI and MCP that compare trimmed values (a whitespace-only assignee counts as unassigned), and filtering and grouping by assignee on the UI Tasks page. A Go binary built from the PR head (2b3f88d) is the oracle for these behaviors. The PR is not merged into the Go code (D2). Added 2026-11-07.
- D14: v0.35.0 adds `knowns qdrant setup` per @doc/specs/2026-11-07/qdrant-setup-wizard: a wizard that detects an answering Qdrant, the managed artifact and Docker and picks by that priority, a Docker branch that runs and manages container `knowns-qdrant` on loopback, a per-machine endpoint file outranking project config (never written into `.knowns/`, so D10 holds), the `knowns init` wizard hook, warnings that point at `knowns qdrant setup`, and a pinned managed artifact for `windows/amd64`. Go 0.34.1 is not changed (D2). Added 2026-11-07.

## Approved Divergences

Each item differs from 0.34.1 under D12. Where only a side effect differs, output and exit code still match 0.34.1.

- MCP permissions: every action a handler implements is classified, and an unlisted action of a known tool counts as a write. 0.34.1 let read-only sessions write through the decision tool and several other actions. (@task-TSR-A3N6KY)
- MCP server notifications: the port file must hold only a port number, and URL segments are escaped. (@task-TSR-A3N6KY)
- MCP server: a handler that throws answers with an internal error instead of leaving the request unanswered. (@task-TSR-A3N6KY)
- Tunnel stop never signals a pid of 1 or less. (@task-TSR-Q7B522)
- `knowns update` on Windows restores the previous binary if the final rename fails, and cleans up its temp file. (@task-TSR-2P6ZDV)
- LSP daemon: a 30 s request read deadline, a 16 MB frame cap, the socket chmod 0600, and a 10 minute timeout per language-server download during init. (@task-TSR-XSEKND)
- Managed Qdrant installer: a pid-stamped install lock and recovery of an interrupted activation. (@task-TSR-30A1BM)
- Store sync: a failing store no longer stops the other stores or the service. (@task-TSR-YZY173)
- A rejected update on a hard-deleted Task never rewrites its file. 0.34.1 writes, then rolls back. (@task-TSR-6ERKFQ)
- Task hard-delete runs its reconcile preflight before reserving the id, so a refusal leaves no half-deleted Task. On refusal, stdout reports changed=0 and no eventId. (@task-TSR-8CXR89)
- Doc hard-delete fails with exit 1 on a Doc it cannot delete. 0.34.1 printed "Permanently deleted doc" with exit 0 and kept the file. (@task-TSR-N5EFM6)
- `knowns validate --fix` assigns stable ids to legacy Docs that have none. 0.34.1 assigns an id only when it rewrites a Doc, and its reconciler then refuses the whole store. (@task-TSR-WR33ZF)
- Hard-deleting a Task whose only history is the legacy path-keyed `versions/task-<id>.json` (written by 0.25.x) succeeds. 0.34.1 reserves the id, then fails to migrate that history and leaves the Task visible but frozen on every retry. TS converts the legacy history before the purge, so the delete completes, and a delete already stuck by 0.34.1 completes on retry. (@task-TSR-481DH6)
- Web server: a request Origin is accepted only when it names the server's own host and port (loopback aliases on the same port count as one host). 0.34.1 trusted every loopback origin on any port, so another local page could read and write the knowledge base. Requests without an Origin are unchanged, and `KNOWNS_ALLOWED_ORIGINS` lists exact extra origins, for example the Vite dev UI. (@task-TSR-X86JV4)
- `knowns update` verifies the downloaded archive against the `<asset>.sha256` published next to it, and refuses a mismatching, missing or malformed checksum without touching the current binary. 0.34.1 installed whatever the download returned. Successful updates print exactly what 0.34.1 prints. (@task-TSR-CRAT15)
- `knowns update` extracts the release into a directory of its own and installs only a binary found there. 0.34.1 extracted next to the downloaded `knowns-<platform>.tar.gz`, which its `knowns-*` matcher also accepts, so the archive itself could be installed as the binary while it reported "Upgrade complete." (@task-TSR-CRAT15)
- Runtime queue on Windows: a rename over the queue, status, reload or registry file, and a read of one, retries for up to 2 s while another process holds the file open (access denied, sharing or lock violation). 0.34.1 failed the queue update or the reader, so a job could be lost or a CLI could fail while the daemon was writing. Same change as contributor PR #157. (@task-TSR-5EEY7V)
- Full reindex stamps entity watermarks that have no manifest entry, from their own canonical fields. 0.34.1 stamped only manifest entries, so a store used only through the CLI kept every watermark stale after a reindex that reported success, and semantic search stayed on keyword. (@task-TSR-6T3JVM)
- `knowns search --reindex` waits for the runtime job for as long as it makes progress (a 5 minute window without movement replaces the fixed 5 minute cap). When it stops waiting on a job that is still in the queue it no longer prints "reindex failed": it says the reindex is still running, with the job id, its phase and `knowns runtime ps`, or, when the runtime daemon is gone, that the runtime stopped, the job stays queued, and `knowns search --reindex` starts the runtime again and reuses the job. The exit code stays 1, as in 0.34.1, and `knowns sync` no longer adds "Warning: reindex failed" for either case. 0.34.1 reported a failure for a reindex the daemon went on to finish, so users queued a second full reindex. Allowed by the 2026-11-10 widening of D12. Tests: test/cli/commands/reindex-wait.test.ts. (@task-KN-Q6DVKQ)

## System Decision Impact

- Impact: draft new
- Decision: @decision/20261103-1709-knowns-runtime-is-typescript-compiled-with-bun
- Acceptance gate: the decision becomes accepted only when AC-1 through AC-6 pass and the v0.35.0 release gate (D11) is met. Until then Go remains the shipped runtime.

## Requirements

### Functional Requirements

- FR-1: CLI parity. Every command and flag listed by `knowns --help` on 0.34.1 exists with the same name, arguments, exit codes, and output, except the removals in D7 and D8.
- FR-2: MCP parity. Every MCP tool, action, parameter, and response shape served by `knowns mcp` on 0.34.1 is served identically over stdio.
- FR-3: HTTP server parity. `knowns browser` serves the embedded UI and every REST endpoint, SSE stream, and WebSocket channel the UI uses, with the same request and response shapes.
- FR-4: Storage parity. Tasks, docs, decisions, memory, templates, time entries, history, versions, config, and workspace registry are read and written in the exact on-disk format of 0.34.1, including hash chains and mutation transactions.
- FR-5: Search parity. Keyword search, semantic search through Ollama embeddings and Qdrant (managed runtime and external), degradation to keyword results when the embedder fails, retrieval with citations, and the runtime job queue including dead letters and `knowns runtime retry`.
- FR-6: Code intelligence parity. `knowns code` and `knowns lsp` work through the LSP manager, the LSP daemon, and every built-in language adapter shipped in 0.34.1, including auto-install of language servers.
- FR-7: Lifecycle parity. The automatic reconciler, file watcher, git-backed store sync, and tombstone restore behave as in 0.34.1 (D7).
- FR-8: Setup parity. `init`, `setup`, `sync`, `agents`, `runtime` hooks, `update`, `migrate`, `doctor`, and skill and instruction sync produce the same files and platform configs as 0.34.1.
- FR-9: OS regression coverage. Before the rewrite starts, Go history is mined for OS-specific fixes (Windows paths and casing, BOM handling, process and console handling, PATH linking, binary replacement by rename, macOS kqueue descriptor limits, USERPROFILE/HOME isolation). Each becomes a test that the TypeScript build must pass on the affected platform.
- FR-10: Removed features (D7, D8) fail clearly: invoking `knowns import` or `knowns reconcile preview|apply` prints a message naming the removal and exits non-zero.
- FR-11: Rollback. A project used by the TypeScript build can be opened by 0.34.x with no data loss and no migration step.

### Non-Functional Requirements

- NFR-1: Size and startup budgets per D5, measured in CI on every platform build. The size check compiles an empty entry for the same target with the same Bun version and compares against it.
- NFR-2: TypeScript runs with `strict: true`; `any` is disallowed by lint outside generated code.
- NFR-3: Every boundary input (CLI args, MCP arguments, HTTP bodies, files read from `.knowns/`) is validated against a schema before use.
- NFR-4: No native Node addons. SQLite goes through `bun:sqlite`; Windows named pipes and process control use Bun or Node built-ins.
- NFR-5: Cross-compiled binaries for darwin, linux, and windows on x64 and arm64.

## Acceptance Criteria

- [ ] AC-1: The Go e2e suite (`tests/e2e_cli_test.go`, `tests/e2e_mcp_test.go`, `tests/e2e_structural_test.go`, `tests/e2e_cli_text_verbatim_test.go`) passes with `TEST_BINARY` set to the TypeScript binary on all 6 platforms, with only the tests for D7 and D8 removals changed.
- [ ] AC-2: Every OS regression test from FR-9 passes on its affected platform.
- [ ] AC-3: UI Playwright e2e (`ui/e2e`) passes against `knowns browser` from the TypeScript binary.
- [ ] AC-4: CI reports, for every platform, the binary size delta over an empty Bun binary at most 30MB, and `knowns --version` and MCP readiness at most 150ms.
- [ ] AC-5: A project created and modified by the TypeScript build opens in 0.34.x; `knowns validate` on 0.34.x reports no errors and all tasks, docs, memory, decisions, and history remain readable.
- [ ] AC-6: An existing 0.34.1 project, including one with `.knowns/imports/` content and Qdrant-indexed semantic search, works under the TypeScript build with no migration step; imported content appears in `search`.
- [ ] AC-7: `knowns import` and `knowns reconcile preview|apply` print a removal message and exit non-zero; `knowns reconcile restore` works as in 0.34.1.
- [ ] AC-8: The maintainer has used the TypeScript build on this repository for at least 14 consecutive days with no data-loss bug, recorded in the release task.
- [ ] AC-9: v0.35.0 is published to npm and the install scripts; `npm i knowns@0.34` and `install.sh --version 0.34.x` still install the Go build.

## Scenarios

### Scenario 1: Upgrade an existing project
**Given** a project last used with knowns 0.34.1, with tasks, docs, memory, history, and a Qdrant semantic index
**When** the user installs v0.35.0 and runs `knowns task list --plain`, `knowns search "<query>" --plain`, and `knowns mcp`
**Then** output matches 0.34.1, semantic results come from the existing index, and no migration is required

### Scenario 2: Roll back after a bad release
**Given** a project modified by v0.35.0
**When** the user installs 0.34.x and runs `knowns validate`
**Then** validation passes and every entity written by v0.35.0 is readable

### Scenario 3: Project with imported packages
**Given** a project with content in `.knowns/imports/`
**When** the user runs `knowns search` and `knowns import sync` on v0.35.0
**Then** search returns imported content, and `import sync` prints the removal message and exits non-zero

### Scenario 4: Git stash removes files briefly
**Given** a project on v0.35.0 with the watcher running
**When** `git stash -u` removes untracked docs and `git stash pop` restores them byte-identical
**Then** reconciliation records a restore and later writes to those docs succeed

### Scenario 5: Windows install
**Given** a Windows machine where PowerShell writes UTF-8 with BOM
**When** the user installs v0.35.0 with `install.ps1` and later runs `knowns update`
**Then** install metadata is read without error (regression of #155) and the binary is linked onto PATH

### Scenario 6: Ollama unavailable
**Given** semantic search is configured but Ollama is not running
**When** the user runs `knowns search "<query>"`
**Then** keyword results are returned with a degraded-search notice, as in 0.34.1

## Technical Notes

- Port order suggestion: storage and models, then CLI for task/doc/memory/decision, then MCP, then HTTP server, then search and runtime queue, then LSP and daemon, then setup/sync/doctor/update.
- The Go e2e harness already supports `TEST_BINARY` (`tests/helpers_test.go`), so it is the parity oracle until the switch.
- Package sizes for planning (non-test Go lines): cli 21k, storage 17k, search 14k, lsp 9k, server 8k, mcp 8k.
- The TUI (bubbletea, huh, glamour) needs a TypeScript equivalent; the choice is an implementation detail as long as FR-1 output matches.

## Task Generation

- Task Prefix: TSR

## Task Links

Execution order; wave 1 runs in parallel, wave 2 blocks everything after it.

- @task-TSR-GM1E2A - Capture OS-specific regressions as binary-level tests (wave 1)
- @task-TSR-5BRB3D - Scaffold the TypeScript workspace, build, and budget checks (wave 1)
- @task-TSR-2BD194 - Port storage and models with on-disk format parity (wave 2)
- @task-TSR-ZH1CYS - Port CLI commands for knowledge entities
- @task-TSR-A3N6KY - Port the MCP server
- @task-TSR-Q7B522 - Port the HTTP server for the web UI
- @task-TSR-2MPMDK - Port search, embeddings, Qdrant and the runtime queue
- @task-TSR-MBTAN6 - Port reconciler, watcher, store sync and restore
- @task-TSR-XSEKND - Port code intelligence: LSP manager, daemon and adapters
- @task-TSR-2P6ZDV - Port setup, sync, doctor, update, migrate and interactive TUI
- @task-TSR-8WCHX1 - Handle removed import command and keep imported content readable
- @task-TSR-Z7CRS1 - Ship v0.35.0 distribution with Go rollback path
- @task-TSR-9VVJA6 - Pass the v0.35.0 release gate

## Open Questions

- [ ] After the switch the Go e2e suite still needs the Go toolchain in CI. Keep it in Go, or port it to TypeScript after v0.35.0?
- [ ] D2 freezes Go for many months. Is there a maximum freeze length after which the plan is re-evaluated?
- [ ] Which TUI library replaces bubbletea, and does the interactive `settings` and `init` wizard need pixel-identical rendering or only equivalent behavior?


## Resolved Questions

- 2026-11-05, TUI: the interactive init and settings wizard needs equivalent behavior, not pixel-identical rendering. That means the same questions, order, defaults, validation and resulting files. It is built with @clack/prompts. Non-interactive output stays under D6 byte parity. Tracked in @task-TSR-2P6ZDV.
