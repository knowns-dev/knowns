---
title: Knowns Doctor
description: Specification for an offline-first, read-only diagnostic command covering Knowns project setup, local services, and actionable remediation.
createdAt: '2026-07-24T23:06:06.475Z'
updatedAt: '2026-07-26T06:58:37.992Z'
tags:
  - spec
  - approved
  - cli
  - diagnostics
---

## Overview

`knowns doctor` is a read-only diagnostic command for verifying a Knowns installation after setup or update and for troubleshooting an unhealthy or degraded project. It evaluates the active project, local storage and configuration, validation summary, search and indices, managed runtimes, language servers, and configured AI integrations through one stable diagnostic contract.

The command complements existing commands instead of replacing them:

- `knowns status` reports the current readiness snapshot.
- `knowns validate` reports detailed task, doc, template, and SDD integrity issues.
- `knowns doctor` explains which checks passed or failed, why the project is degraded or unhealthy, and the exact remediation command when one exists.

The same diagnostic model must support styled terminal output, plain output, and structured JSON for AI agents and CI.

## Locked Decisions

- D1: `knowns doctor` serves both post-setup/update verification and reactive troubleshooting. It supports terminal users and AI/CI through one diagnostic contract. It is offline by default and performs external network checks only with `--online`.
- D2: The default command runs every applicable local check across project core, search, runtime, LSP, validation, and configured AI integrations. A subsystem disabled by explicit configuration is `skip`; a subsystem that is enabled or configured but unavailable creates a finding. Validation is executed but represented only as an aggregate check that directs users to `knowns validate` for details.
- D3: The first version is entirely read-only and has no `--fix`. Each actionable finding includes an exact remediation command when possible, otherwise a manual remediation description. Evidence is limited to safe metadata and file paths; the command does not print raw config or log content.
- D4: Each check has status `pass`, `warn`, `fail`, or `skip`, and the run has verdict `healthy`, `degraded`, or `unhealthy`. Exit codes follow the defined CLI contract, with `--strict` making warnings fail automation. Default terminal output shows the summary and actionable problems, `--verbose` shows all checks, and `--json` always returns the complete selected diagnostic result.

## Goals

- Give users one command that establishes whether a Knowns project and its locally configured capabilities are operational.
- Turn detected problems into actionable, copyable remediation steps.
- Provide a deterministic result contract suitable for shell scripts, CI, and AI agents.
- Reuse canonical readiness, validation, service, search, and LSP probes so diagnostic state does not diverge from other Knowns surfaces.
- Continue independent checks after a subsystem failure so one problem does not hide unrelated findings.

## Non-Goals

- Automatically fixing, installing, reindexing, syncing, or mutating project/global state.
- Replacing the detailed output or repair behavior of `knowns validate`, `knowns status`, `knowns sync`, `knowns search`, or `knowns lsp`.
- Printing raw configuration values, raw logs, environment dumps, credentials, tokens, or a support bundle.
- Adding a server endpoint, Web UI surface, or MCP tool in the first version.
- Calling external services without the explicit `--online` flag.

## Diagnostic Model

### Run Result

A diagnostic run exposes the following logical fields in structured output:

```json
{
  "schemaVersion": 1,
  "verdict": "degraded",
  "strict": false,
  "online": false,
  "project": {
    "active": true,
    "name": "my-project",
    "path": "/path/to/my-project",
    "knownsVersion": "0.42.0"
  },
  "summary": {
    "pass": 12,
    "warn": 2,
    "fail": 0,
    "skip": 3
  },
  "checks": []
}
```

### Check Result

Each check exposes:

- `id`: stable machine-readable identifier, such as `search.project-index`.
- `scope`: stable scope identifier.
- `status`: `pass`, `warn`, `fail`, or `skip`.
- `summary`: concise human-readable outcome.
- `evidence`: optional safe, typed metadata such as path, version, count, PID, configured state, or normalized error code.
- `remediation`: optional object containing a concise description and an exact Knowns command when available.
- `skipReason`: required when status is `skip`.

Raw configuration values, environment dumps, and log excerpts are forbidden in `evidence`.

### Status and Verdict Rules

- `pass`: the check's required condition is satisfied.
- `warn`: the capability remains usable but is degraded, stale, incomplete, or requires attention.
- `fail`: a configured or required capability cannot operate, project state is invalid, or the check itself cannot establish a safe result.
- `skip`: the subsystem is explicitly disabled, not applicable to this project, excluded by scope, or requires `--online` when online mode is absent.
- `unhealthy`: at least one selected check is `fail`.
- `degraded`: no selected check is `fail` and at least one selected check is `warn`.
- `healthy`: selected checks contain neither `fail` nor `warn`.
- `skip` never degrades the verdict by itself.

## Requirements

### Functional Requirements

- FR-1: The CLI must expose `knowns doctor` with styled human output by default and support the existing global `--plain` and `--json` output modes.
- FR-2: Without a scope filter, the command must run every applicable local diagnostic check and must not contact an external network service.
- FR-3: The command must support `--online`; only this mode may run registered external checks such as update availability and configured provider connectivity.
- FR-4: The command must support one or more named `--scope` values so callers can restrict execution without changing check semantics. Initial scopes must cover `project`, `validation`, `search`, `runtime`, `lsp`, `ai`, and `online`.
- FR-5: The command must support `--verbose`. Default styled/plain output must show project identity, overall verdict, summary counts, and every `warn` or `fail`; verbose output must additionally show `pass` and `skip` checks.
- FR-6: JSON output must return the complete selected diagnostic result, including schema version, project identity, verdict, summary counts, every selected check, evidence, skip reasons, and remediation.
- FR-7: Checks and scopes must use stable identifiers and deterministic ordering across runs when project state is unchanged.
- FR-8: Project checks must diagnose active-project detection, project configuration readability and parseability, required Knowns storage paths, and safe filesystem permission metadata without creating probe files.
- FR-9: Validation must use the canonical validation engine and produce exactly one aggregate `validation.summary` check. Validation errors make that check `fail`, warnings without errors make it `warn`, and a clean result makes it `pass`. Its remediation must direct users to `knowns validate` for details.
- FR-10: Search checks must diagnose semantic-search configuration, configured model availability, project/global index readiness, index freshness when known, and semantic runtime state without performing a reindex or model download.
- FR-11: Runtime checks must diagnose configured managed-service state using bounded local probes, including stopped, unhealthy, stale, or disabled services, without starting or stopping a process.
- FR-12: LSP checks must diagnose every configured or project-detected language using the canonical LSP status collector, including prerequisites, selected backend, installation, binary/version, daemon state, readiness, and capability gaps where available.
- FR-13: AI integration checks must diagnose locally configured platform artifacts, instruction/skill synchronization state, and other non-secret local consistency signals for applicable platforms without writing synchronized files.
- FR-14: A subsystem disabled by explicit configuration must produce `skip`; an enabled or configured subsystem whose required dependency is missing or unhealthy must produce `warn` or `fail` according to whether its advertised capability remains usable.
- FR-15: Every `warn` and `fail` must include actionable remediation. The result must include an exact copyable Knowns command when a safe existing command addresses the issue; otherwise it must include a concise manual action.
- FR-16: The first version must not expose `--fix` and must not execute remediation commands.
- FR-17: Evidence must be limited to safe metadata such as booleans, normalized states, versions, paths, counts, PIDs, ports, capability names, and normalized error codes. It must not contain raw config values or log content.
- FR-18: External checks must be represented as `skip` with reason `online_disabled` when `--online` is absent. When enabled, failure to reach one external service must not prevent other checks from completing.
- FR-19: Independent checker failures and timeouts must be converted into check results and must not abort the remaining diagnostic run.
- FR-20: Exit code must be `0` for `healthy` and `degraded`, `1` for `unhealthy`, and `2` when the diagnostic engine cannot initialize or complete a valid result. With `--strict`, `degraded` must return `1` while the JSON verdict remains `degraded`.
- FR-21: Missing active-project state must be represented as a valid unhealthy diagnostic result with a project finding and exit code `1`, not as an engine failure with exit code `2`.
- FR-22: The command must not change project files, global Knowns files, indices, installed tools, process state, platform artifacts, or configuration as a result of running any supported flag combination.

### Non-Functional Requirements

- NFR-1: The command must behave consistently on supported macOS, Linux, and Windows environments.
- NFR-2: Each external process, local service, and network probe must have a bounded timeout and honor command cancellation.
- NFR-3: Check execution must be isolated so a panic, timeout, or malformed response from one checker cannot suppress results from unrelated checkers.
- NFR-4: JSON field names, check IDs, scope IDs, status values, verdict values, and exit-code semantics form a versioned compatibility contract.
- NFR-5: Human output must remain understandable without color, and `--plain` must contain no ANSI formatting.
- NFR-6: Secret-bearing values must be excluded at the data-collection boundary rather than relying only on output-time redaction.
- NFR-7: Results must be deterministic except for explicitly time-varying evidence such as process state, timestamps, duration, or remote availability.
- NFR-8: The implementation must use canonical project readiness, validation, managed-service, semantic-runtime, and LSP sources wherever they already exist.

## Acceptance Criteria

- [x] AC-1: On a healthy configured project, `knowns doctor` returns verdict `healthy`, prints no actionable problems in default output, and exits `0`.
- [x] AC-2: `knowns doctor --verbose` displays `pass`, `warn`, `fail`, and `skip` checks with stable IDs in deterministic order.
- [x] AC-3: `knowns doctor --json` emits the versioned run-result contract with project identity, summary counts, complete selected checks, safe evidence, skip reasons, and remediation.
- [x] AC-4: A configured semantic model that is unavailable produces an actionable search finding without downloading the model or modifying config.
- [x] AC-5: An empty or stale configured project index produces a finding with an appropriate `knowns search --reindex` remediation command and does not reindex automatically.
- [x] AC-6: A configured language server that is missing produces a finding containing its canonical `knowns lsp install <language>` command when installation is supported.
- [x] AC-7: An explicitly disabled runtime, LSP, search, or AI integration produces `skip` and does not affect the overall verdict by itself.
- [x] AC-8: Validation errors produce one failing `validation.summary` check with counts and remediation pointing to `knowns validate`; individual validation issues are not duplicated in doctor output.
- [x] AC-9: A timed-out or failed runtime/LSP/provider probe is represented as a check result while independent checks still run and appear in output.
- [x] AC-10: Without `--online`, an instrumented test confirms that no external network request occurs and online checks report `skip` with reason `online_disabled`.
- [x] AC-11: With `--online`, registered version and configured-provider connectivity checks execute independently and cannot prevent local checks from completing.
- [x] AC-12: Default terminal output contains the verdict, summary, and every `warn`/`fail`, while omitting `pass`/`skip`; `--verbose` includes all checks.
- [x] AC-13: Healthy and degraded runs exit `0`; unhealthy runs exit `1`; `--strict` makes a degraded run exit `1` without changing its verdict; engine-level failure exits `2`.
- [x] AC-14: Running doctor with no active project yields a structured unhealthy result, actionable project remediation, and exit `1`.
- [x] AC-15: Tests containing credentials in config, environment, and logs confirm that no raw secret or raw log content appears in styled, plain, verbose, or JSON output.
- [x] AC-16: A before/after filesystem and process-state test confirms that `knowns doctor`, including `--verbose`, `--json`, scoped, strict, and online modes, performs no Knowns state mutation or process lifecycle action.
- [x] AC-17: `--scope project,lsp` runs or returns only the selected scopes according to the documented JSON contract and rejects unknown scope IDs with a usage error.
- [x] AC-18: Plain output contains no ANSI escape sequences and communicates every non-passing status without relying on color.
- [x] AC-19: Supported-platform tests verify equivalent status, verdict, exit-code, and secret-safety behavior on macOS, Linux, and Windows.

## Scenarios

### Scenario 1: Healthy Project Verification

**Given** an active project with readable configuration and storage, valid knowledge entities, ready search indices, and all configured local services available
**When** a developer runs `knowns doctor`
**Then** the command reports `healthy`, shows summary counts without problem details, performs no mutation, and exits `0`.

### Scenario 2: Troubleshooting Missing Local Dependencies

**Given** semantic search, a language server, or an AI runtime is configured but its required model, binary, or Knowns runtime-memory hook is unavailable
**When** a developer runs `knowns doctor`
**Then** the command reports the affected checks as warnings or failures, derives an unhealthy or degraded verdict, and prints exact model/index/LSP/runtime-hook remediation commands where supported.

### Scenario 3: Intentionally Disabled Subsystem

**Given** an optional subsystem is explicitly disabled in project configuration
**When** doctor evaluates the subsystem
**Then** its checks report `skip` with a configuration-based reason and do not degrade the verdict.

### Scenario 4: Invalid Knowledge Content

**Given** canonical validation finds three errors and five warnings
**When** doctor runs
**Then** it returns one failing `validation.summary` check with those counts and tells the user to run `knowns validate`, without copying the eight individual issues.

### Scenario 5: Partial Probe Failure

**Given** one managed local service does not respond before its probe timeout
**When** doctor runs
**Then** that check reports a normalized failure with safe evidence while all unrelated project, search, validation, LSP, and AI checks still complete.

### Scenario 6: CI Strict Mode

**Given** a project has warnings but no failed checks
**When** CI runs `knowns doctor --json --strict`
**Then** JSON verdict remains `degraded`, all selected checks are present, no ANSI output is emitted, and the process exits `1`.

### Scenario 7: Offline Default

**Given** external networking is unavailable
**When** a user runs `knowns doctor` without `--online`
**Then** local diagnosis completes normally, no external request is attempted, and online checks are skipped without degrading the verdict.

### Scenario 8: Explicit Online Diagnosis

**Given** the user explicitly supplies `--online` and one configured external provider is unreachable
**When** doctor runs
**Then** the provider check reports an actionable finding while every local and other online check continues independently.

### Scenario 9: Sensitive Local State

**Given** project config, environment, or logs contain credentials
**When** doctor is run in every output mode
**Then** output contains only allowlisted metadata and paths and never contains raw credentials, raw config values, or log excerpts.

### Scenario 10: No Active Project

**Given** the current directory is outside an initialized Knowns project and no project is active
**When** the user runs `knowns doctor --json`
**Then** the command returns a valid unhealthy diagnostic result with project initialization guidance and exit code `1`.

## Technical Notes

- Use `internal/readiness.BuildReadiness` as a source of canonical state, but do not infer doctor findings solely from its payload because readiness collection intentionally tolerates some read/config failures.
- Reuse `internal/validate.Run` for the aggregate validation check.
- Reuse `internal/services.DetectAllReadOnly` and `internal/lsp.CollectRuntimeStatuses` for bounded, side-effect-light service and LSP inspection; retain `DetectAll` cleanup behavior for existing non-diagnostic callers.
- Keep diagnostic collection and CLI rendering separate so all output modes consume the same result model.
- Model checkers behind a small registry/runner abstraction with stable check and scope IDs; the implementation plan determines exact package boundaries and scheduling.
- Checker evidence should be typed or allowlisted at collection time. Do not attach arbitrary command output, complete errors from external tools, environment maps, config structs, or log lines.
- Existing global `--plain` and `--json` behavior should be reused rather than redefining incompatible command-local flags.

## Task Links

- @task-1kzsf5 [knowns-doctor-01] Build diagnostic core and foundational checks (done)
- @task-kleaqp [knowns-doctor-02] Add local subsystem diagnostic checks (done)
- @task-4elfic [knowns-doctor-03] Wire CLI rendering scopes and exit behavior (done)
- @task-lmztcl [knowns-doctor-04] Add online diagnostics and safety hardening (done)
- @task-df57my [knowns-doctor-05] Complete cross-platform verification and documentation (done)

## Open Questions

None. The product purpose, default scope, applicability semantics, remediation policy, evidence boundary, output contract, verdict model, and exit-code behavior are locked for this version.
