---
id: doc-044e9a2c85a806614c9f015ee4c90fc4
title: Qdrant Setup Wizard
description: 'Specification for knowns qdrant setup: auto-detect and set up a Qdrant backend (existing, managed, Docker), plus the Windows x64 managed artifact'
createdAt: '2026-11-07T06:23:09.819Z'
updatedAt: '2026-11-07T09:33:27.340Z'
tags:
  - spec
  - approved
---

## Overview

Semantic search needs a Qdrant endpoint. Knowns 0.34.1 only offers managed Qdrant on darwin/arm64, darwin/amd64, linux/amd64 and linux/arm64; everywhere else `knowns sync` and reindex print `install managed Qdrant: unsupported Qdrant platform windows/amd64; configure an external Qdrant endpoint` and leave the user to read `docs/en/reference/external-qdrant.md` and set things up by hand. A Windows user hit this on 2026-11-07.

This spec adds `knowns qdrant setup`, a wizard that detects what the machine can run and picks the best Qdrant backend on its own, asking only when there is a real choice or a side effect. It also adds the pinned Windows x64 managed artifact, so most Windows users never need the wizard's Docker branch.

Scope: the TypeScript build only (v1.0.0). It is recorded as a v1.0.0 addition in @doc/specs/2026-11-03/knowns-typescript-rewrite, the way D13 records PR #156. Go 0.34.1 stays frozen.

## Locked Decisions

- D1: The wizard detects first and chooses by priority, asking only when more than one option is valid or an option has side effects. Priority: (1) a Qdrant already answering at `KNOWNS_QDRANT_URL` or `127.0.0.1:6333` with a compatible version: write config only, install nothing; (2) managed, when the platform has a pinned artifact; (3) Docker, when `docker` exists and its daemon answers; (4) nothing usable: report keyword-only search with guidance to install Docker or point at an endpoint. `--yes` or no TTY (CI) takes the first valid option without asking.
- D2: The Docker branch runs and manages the container itself. After one confirmation (skipped by `--yes`) it runs the pinned image `qdrant/qdrant:v1.14.1` as container `knowns-qdrant` with a named volume, publishes only `127.0.0.1:6333`, sets `--restart unless-stopped`, waits for `/healthz` and then records the endpoint. `knowns qdrant status`, `start` and `stop` recognize and act on that container.
- D3: Entry points: the explicit `knowns qdrant setup` command, and the `knowns init` wizard when it enables semantic search. When init finds managed it stays lazy (D10 of @doc/specs/2026-08-13/qdrant-default-vector-backend: nothing is downloaded at init). `knowns init --no-wizard` asks nothing. Warnings from sync, reindex and search that today say "configure an external Qdrant endpoint" point at `knowns qdrant setup` instead.
- D4: TypeScript v1.0.0 only, recorded as a v1.0.0 addition (D14) in @doc/specs/2026-11-03/knowns-typescript-rewrite. Go 0.34.1 is not changed.
- D5: The managed installer gains a pinned `windows/amd64` artifact: `qdrant-x86_64-pc-windows-msvc.zip` from the Qdrant v1.14.1 release (the asset exists, checked 2026-11-07), with its SHA256 taken from the downloaded file. Install, start and index are verified on a real Windows x64 machine.
- D6: The wizard's choice is stored per machine, never in the project. A machine file under the managed Qdrant root (for example `~/.knowns/runtime/qdrant/endpoint.json`) records the endpoint, its source (`existing`, `docker`) and whether Knowns owns a Docker container. Resolution order becomes env > machine file > project config > global settings > defaults. `.knowns/config.json` is never changed by the wizard, so teammates on other platforms keep managed, and the rewrite spec's D10 holds. Go 0.34.x ignores the machine file.

## System Decision Impact

- Impact: none
- Decision: none. The vector backend stays Qdrant; this adds a way to reach one. The per-machine endpoint file is a scoped execution rule of this spec (D6), not durable project-wide guidance.
- Acceptance gate: not applicable.

## Requirements

### Functional Requirements

- FR-1: `knowns qdrant setup` detects, in this order, an answering Qdrant at `KNOWNS_QDRANT_URL` then `127.0.0.1:6333`, a pinned managed artifact for the current platform, and a usable Docker (binary on PATH and `docker info` succeeds), and prints what it found.
- FR-2: It chooses the highest-priority valid option per D1. With a TTY and more than one valid option, it shows the options with the chosen one as the default. With `--yes` or without a TTY it takes the default and asks nothing.
- FR-3: Existing branch: it checks `/healthz` and the Qdrant version, and records the endpoint in the machine file without starting or installing anything.
- FR-4: Managed branch: it records nothing new and defers to the existing managed flow; with `--now` it runs the blocking install and start (`knowns qdrant install` behavior).
- FR-5: Docker branch: after confirmation it pulls and runs the pinned image per D2, waits for `/healthz` with a bounded timeout, and records the endpoint and container ownership in the machine file. If `knowns-qdrant` already exists it reuses it (starting it when stopped) instead of creating a second one.
- FR-6: Nothing-usable branch: it exits non-zero with a message naming what was missing (no managed artifact for `<os>/<arch>`, no Docker or Docker daemon not running) and the two ways forward: install Docker and rerun, or `knowns qdrant setup --url <endpoint>`.
- FR-7: Flags: `--yes`, `--url <endpoint>` (use this endpoint, validated like FR-3), `--docker`, `--managed` (force a branch; fail clearly if it is not valid here), `--now`, `--remove`, `--json` and `--plain`.
- FR-8: Every Qdrant consumer (search, retrieve, sync, reindex, MCP, web server, doctor, `knowns qdrant status/start/stop/logs/cleanup/purge`) resolves the endpoint with the D6 order.
- FR-9: With a Docker-owned endpoint, `knowns qdrant status` reports the container and its state, `start` starts it, `stop` stops it, `logs` shows its log, and `knowns qdrant setup --remove` removes the container, asks before removing its volume (which holds every project's vectors), and deletes the machine file. `knowns qdrant purge` keeps its 0.34.1 per-project meaning, because the container is shared by every project on the machine (decided 2026-11-07). Endpoints from the existing branch are treated as external: never started, stopped or removed; `--remove` only forgets them.
- FR-10: `knowns init`, when the wizard enables semantic search, runs the FR-1 detection and follows D3. `init --no-wizard` is unchanged.
- FR-11: The managed installer supports `windows/amd64` per D5, including `qdrant.exe`, its data directory and process control on Windows.
- FR-12: Warnings that say "configure an external Qdrant endpoint" (installer, reindex, doctor) end with "run `knowns qdrant setup`".
- FR-13: `knowns doctor` reports the machine file's endpoint and source when present, and flags a recorded endpoint that does not answer.

### Non-Functional Requirements

- NFR-1: The wizard never writes `.knowns/` (D6). The project config is byte-identical before and after.
- NFR-2: No API key or secret is written to the machine file or printed; external keys stay in `KNOWNS_QDRANT_API_KEY`.
- NFR-3: Docker is published on loopback only. The wizard never binds `0.0.0.0`.
- NFR-4: Detection completes in under 3 seconds when nothing answers (bounded health-check and `docker info` timeouts).
- NFR-5: Outside the new command, the new flags and the D6 resolution step, output stays identical to 0.34.1 (rewrite spec D6), except the FR-12 wording.

## Acceptance Criteria

- [ ] AC-1: On a machine where Qdrant already answers at `127.0.0.1:6333`, `knowns qdrant setup --yes` records it with source `existing`, installs and starts nothing, and a following `knowns search index --wait` builds the semantic index against it.
- [ ] AC-2: On darwin/linux with no Qdrant running, `setup --yes` picks managed and writes no machine file; `setup --now --yes` also installs and starts it.
- [ ] AC-3: On a platform without a managed artifact and with Docker, `setup --yes` starts container `knowns-qdrant` from `qdrant/qdrant:v1.14.1` published on `127.0.0.1:6333` only, waits for health, records it, and semantic search works afterward.
- [ ] AC-4: Running `setup --yes` twice leaves exactly one `knowns-qdrant` container; a stopped one is started, not recreated.
- [ ] AC-5: Without Docker and without a managed artifact, `setup` exits non-zero with the FR-6 message.
- [ ] AC-6: Without a TTY, `setup` never prompts and behaves like `--yes`.
- [ ] AC-7: `KNOWNS_QDRANT_URL` beats the machine file, and the machine file beats a project config that declares `mode: managed`.
- [ ] AC-8: `.knowns/config.json` is byte-identical after any `setup` run, and Go 0.34.1 still reads the project.
- [ ] AC-9: With a Docker-owned endpoint, `qdrant status/stop/start` act on the container; with an `existing` endpoint they do not touch any process or container.
- [ ] AC-10: `qdrant setup --remove` on a Docker-owned endpoint removes the container, asks before removing the volume (kept with `--yes` unless the volume is asked for explicitly), and deletes the machine file; `qdrant purge` behaves as in 0.34.1.
- [ ] AC-11: On Windows x64, `knowns qdrant install` downloads the pinned zip, verifies its SHA256, and `start`, `search index --wait` and `search` work with managed Qdrant.
- [ ] AC-12: `knowns init` with the wizard and semantic search enabled runs detection: it offers Docker on a platform without managed, stays lazy on a managed platform, and `init --no-wizard` prompts nothing.
- [ ] AC-13: The "configure an external Qdrant endpoint" warnings end with "run `knowns qdrant setup`".
- [ ] AC-14: `knowns doctor` reports a recorded endpoint and flags one that does not answer.
- [ ] AC-15: The rewrite spec carries D14 describing this addition, and the 0.34.1 parity suites stay green apart from the D14 differences.

## Scenarios

### Scenario 1: Windows user with Docker (the reported case)
**Given** Windows x64 before this spec's managed artifact, Docker Desktop running, no Qdrant
**When** the user runs `knowns qdrant setup` and confirms
**Then** container `knowns-qdrant` starts on `127.0.0.1:6333`, the endpoint is recorded per machine, and `kn sync` reindexes without the warning.

### Scenario 2: Windows user after this spec
**Given** Windows x64 with this spec's managed artifact
**When** the user runs `knowns qdrant setup --yes`
**Then** it picks managed (Docker is not needed) and semantic search works after the lazy install.

### Scenario 3: Qdrant already running
**Given** a Qdrant the user started at `127.0.0.1:6333`
**When** `knowns qdrant setup --yes` runs
**Then** it records that endpoint as `existing` and never stops or removes it later.

### Scenario 4: Mixed-platform team
**Given** a project shared by a Windows user on Docker and a Mac user on managed
**When** the Windows user runs `setup`
**Then** `.knowns/config.json` does not change and the Mac user keeps managed.

### Scenario 5: Nothing usable
**Given** Alpine (musl) without Docker and no Qdrant
**When** `knowns qdrant setup` runs
**Then** it exits non-zero, names what is missing, and suggests installing Docker or `--url`.

### Scenario 6: CI
**Given** no TTY and `KNOWNS_QDRANT_URL` set
**When** `knowns qdrant setup` runs
**Then** it asks nothing, records nothing (env already wins), and reports the env endpoint.

## Technical Notes

- TS code to extend: `cli/src/runtime/qdrant-installer.ts` (artifact table, the zip branch already exists), `cli/src/runtime/qdrant.ts` (status/start/stop, `/healthz`), `cli/src/cli/commands/qdrant.ts`, `cli/src/cli/commands/init-steps.ts`, `cli/src/domain/doctor/qdrant-checks.ts`, and vector-store resolution in `cli/src/models/config.ts`.
- Docker is driven through the `docker` CLI (no socket client, no new dependency). Container label `dev.knowns.managed=true` identifies ownership on top of the name.
- Docker on Windows maps loopback differently; verify `127.0.0.1:6333` from the host on the Windows PC.
- Tests: unit tests with a fake `docker` on PATH (as `install-harness.ts` fakes `uname` and `sysctl`); a real Docker run where Docker exists (huit-gpu has Docker only if already installed: install nothing system-wide); the Windows managed path on howznguyen-pc-1 inside `%USERPROFILE%\knowns-tsr` only, with a temp `KNOWNS_RUNTIME_ROOT`.
- Qdrant also publishes `qdrant-x86_64-unknown-linux-musl.tar.gz` for v1.14.1, which could cover Alpine on x64. Out of scope (see Open Questions).

## Task Generation

- Task Prefix: TSR

## Task Links

- @task-TSR-B1GB4G Pin the managed Qdrant artifact for windows/amd64 (todo)
- @task-TSR-JGKNSV Store the Qdrant endpoint per machine (todo)
- @task-TSR-QDJ4CM Add knowns qdrant setup (todo)
- @task-TSR-YGRPXA Run and manage the knowns-qdrant Docker container (todo)
- @task-TSR-2YE01K Hook Qdrant detection into init, warnings and doctor (todo)

## Open Questions

- [ ] What counts as a compatible Qdrant version for the existing branch (exactly 1.14.x, or a minimum)?
- [ ] Should linux/amd64 on musl get the musl artifact too (spillover, separate task)?
