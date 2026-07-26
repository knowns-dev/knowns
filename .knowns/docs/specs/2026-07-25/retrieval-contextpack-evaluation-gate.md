---
title: Retrieval ContextPack Evaluation Gate
description: Specification for deterministic retrieval and ContextPack quality evaluation with committed baselines, CI regression gates, and optional project-local report-only cases.
createdAt: '2026-07-24T22:53:06.195Z'
updatedAt: '2026-07-24T23:23:30.515Z'
tags:
  - spec
  - approved
  - retrieval
  - evaluation
  - contextpack
  - ci
---

## Overview

Add a deterministic, read-only evaluation gate for Knowns retrieval and final ContextPack assembly. The feature extends the existing benchmark foundation with graded relevance, ranked quality metrics, candidate-to-pack diagnostics, committed baselines, and CI regression enforcement.

This spec covers only the first P0 workstream from @doc/research/knowns-evolution-research-2026. It measures current behavior and must not change production ranking, retrieval routing, reference expansion, or ContextPack selection.

## Locked Decisions

- D1: Scope is limited to qrels, ranked retrieval metrics, and ContextPack evaluation. Production retrieval behavior is out of scope.
- D2: Evaluation is available through a read-only CLI surface and CI. No MCP evaluation action is added.
- D3: Evaluation uses two data tiers: canonical deterministic fixtures committed in `knowns-go`, plus optional project-local cases that run manually in report-only mode.
- D4: CI fails when a quality metric regresses beyond its configured tolerance relative to a committed baseline.
- D5: Keyword evaluation runs in the normal CI gate. Semantic and hybrid evaluation run in a separate job with a pinned model/runtime identity and no silent fallback.
- D6: Baselines change only through an explicit update operation. The resulting diff and reason must be reviewed and committed.
- D7: The CLI emits human-readable output and a machine-readable JSON artifact. Evaluation run history is not persisted in Knowns.
- D8: A failed gate reports aggregate results and individual failing cases, including expected and observed ranks, metric deltas, latency, and candidate-to-ContextPack loss.
- D9: Quality metrics use reviewed tolerances. Stale-source avoidance and citation correctness are hard invariants. Latency is report-only in the MVP.
- D10: A semantic or hybrid CI job fails with an explicit readiness error when its pinned runtime is missing or degraded; it never falls back to another mode.
- D11: Invalid fixtures, qrels, or baselines fail before retrieval begins and identify the invalid case and field.
- D12: A canonical case without a committed baseline fails CI and requires an explicit baseline update.
- D13: The gating CI belongs to the `knowns-go` repository. Project-local cases never gate Knowns CI and are excluded from default CI artifacts.

## Requirements

### Functional Requirements

- FR-1: The canonical fixture format must support stable case IDs, query category, query text, graded qrels from `0` to `3`, expected citations or stale-source constraints where applicable, and mode-specific evaluation metadata.
- FR-2: Canonical fixtures and baselines must live outside normal indexed/searchable project knowledge so benchmark queries cannot retrieve themselves.
- FR-3: The evaluator must calculate nDCG@10, MRR@10, Recall@5/10/20, and Success@K for ranked retrieval candidates.
- FR-4: The evaluator must compare candidate retrieval with final ContextPack inclusion and report candidate recall, ContextPack recall, relevant items lost during assembly, context bytes/tokens, and redundancy signals available in the current data model.
- FR-5: The evaluator must check citation correctness and stale-source avoidance for cases that declare those expectations.
- FR-6: Existing `pass`/`partial`/`fail` verdict reporting must remain available for compatibility alongside the new metrics.
- FR-7: A read-only CLI evaluation surface must support canonical fixture runs, a human-readable report, and a JSON artifact with a stable schema suitable for CI consumption.
- FR-8: The CLI must support optional project-local case input. Project-local runs are report-only, cannot update or compare against the canonical Knowns CI baseline by default, and must not be included in default CI artifacts.
- FR-9: Canonical keyword evaluation must compare the current result with a committed baseline and fail when a gated metric regresses beyond its reviewed tolerance.
- FR-10: Semantic and hybrid evaluation must run separately with a pinned model/runtime identity recorded in the report and baseline.
- FR-11: Semantic and hybrid evaluation must return a non-zero result with an actionable readiness error if the required runtime is missing, degraded, or does not match the pinned identity.
- FR-12: Baseline creation or replacement must require an explicit update operation and produce a reviewable diff containing metric changes, fixture changes, runtime identity, and a supplied reason.
- FR-13: A normal evaluation run must never modify fixtures, baselines, project knowledge, or search indexes.
- FR-14: A failed gate must identify each failing case, expected versus observed ranking, affected metric and delta, applicable tolerance, candidate-to-pack loss, and stage latency available to the evaluator.
- FR-15: Invalid fixture fields, qrel values, duplicate case IDs, incompatible baseline schema, missing canonical baselines, and unsupported modes must fail-fast before retrieval starts.
- FR-16: The JSON artifact must distinguish gated failures, hard-invariant failures, readiness failures, fixture/baseline validation failures, and report-only observations.
- FR-17: The Knowns CI workflow must run the canonical keyword gate on relevant search/retrieval changes and provide a separate pinned-runtime job for semantic/hybrid evaluation.

### Non-Functional Requirements

- NFR-1: Repeated canonical keyword runs against the same revision and fixture must produce deterministic metric and exit-status results.
- NFR-2: The evaluation framework must not introduce any production retrieval or ContextPack behavior change.
- NFR-3: Default CI artifacts must not contain project-local queries, content, citations, paths, or other potentially private data.
- NFR-4: The JSON artifact schema and committed baseline format must be versioned so incompatible changes fail explicitly.
- NFR-5: Latency must be measured and reported without acting as a blocking MVP gate.
- NFR-6: Semantic/hybrid results must be attributable to an exact configured mode and pinned runtime/model identity.
- NFR-7: Evaluation failures must be actionable without requiring developers to inspect raw internal traces.

## Acceptance Criteria

- [x] AC-1: A canonical fixture can express graded qrels `0..3`, categories, citation expectations, and stale-source expectations, and invalid values fail before retrieval.
- [x] AC-2: A canonical keyword run reports nDCG@10, MRR@10, Recall@5/10/20, Success@K, existing verdict counts, and p50/p95 latency.
- [x] AC-3: The report distinguishes ranked candidates from final ContextPack items and identifies relevant items lost during ContextPack assembly.
- [x] AC-4: The CLI produces equivalent human-readable and versioned JSON reports without mutating project or benchmark state.
- [x] AC-5: A regression within every configured tolerance passes; a regression beyond any gated tolerance exits non-zero and names the failing metric and cases.
- [x] AC-6: A stale-source or citation-correctness violation exits non-zero regardless of aggregate quality metrics.
- [x] AC-7: The existing `pass`/`partial`/`fail` benchmark summary remains available after ranked metrics are added.
- [x] AC-8: Updating a baseline requires an explicit operation and reason and produces a deterministic, reviewable repository diff.
- [x] AC-9: A newly added canonical case without a baseline fails CI with instructions for explicit baseline review/update.
- [x] AC-10: Keyword evaluation runs in Knowns CI using canonical fixtures and committed baselines.
- [x] AC-11: Semantic/hybrid evaluation records the pinned runtime identity and fails clearly without fallback when the runtime is missing, degraded, or mismatched.
- [x] AC-12: Project-local cases can run manually and produce reports, but never change or gate the canonical Knowns baseline and are absent from default CI artifacts.
- [x] AC-13: Duplicate case IDs, malformed qrels, unsupported schema versions, and incompatible baseline data all fail-fast with case/field-specific errors.
- [x] AC-14: Latency is present in reports but cannot independently fail the MVP gate.
- [x] AC-15: Focused tests prove that evaluation code does not change production ranking, retrieval routing, reference expansion, or ContextPack content.

## Scenarios

### Scenario 1: Canonical keyword gate passes

**Given** canonical fixtures and a committed keyword baseline
**When** CI runs evaluation on unchanged or improved retrieval behavior
**Then** the CLI emits human and JSON reports and exits successfully.

### Scenario 2: Ranked quality regression

**Given** a committed baseline and reviewed tolerances
**When** Recall@10 or another gated quality metric regresses beyond tolerance
**Then** CI fails and reports the affected aggregate, cases, expected/observed ranks, delta, and tolerance.

### Scenario 3: Candidate is lost from ContextPack

**Given** a relevant item appears in ranked candidates
**When** the final ContextPack omits it
**Then** the report distinguishes candidate recall from ContextPack recall and identifies the lost item.

### Scenario 4: Hard invariant violation

**Given** a case declares a current citation or stale-source expectation
**When** retrieval selects an incorrect citation or stale source
**Then** the gate fails even if aggregate ranking metrics remain within tolerance.

### Scenario 5: Semantic runtime unavailable

**Given** the semantic/hybrid CI job requires a pinned runtime
**When** the runtime is missing, degraded, or mismatched
**Then** the job exits non-zero with readiness details and performs no keyword fallback.

### Scenario 6: Invalid fixture

**Given** a canonical fixture contains a duplicate ID or qrel outside `0..3`
**When** evaluation starts
**Then** validation fails before any retrieval call and identifies the exact case and field.

### Scenario 7: New canonical case lacks baseline

**Given** a contributor adds a canonical case
**When** CI runs before its baseline is explicitly reviewed and committed
**Then** CI fails with baseline-update guidance and does not auto-accept current results.

### Scenario 8: Explicit baseline update

**Given** an intentional retrieval change has been reviewed
**When** a developer runs the explicit baseline update with a reason
**Then** the repository receives a deterministic diff showing fixture, metric, tolerance, and runtime-identity changes for review.

### Scenario 9: Project-local evaluation

**Given** a user supplies project-local cases
**When** they run the CLI manually
**Then** the run is report-only, leaves canonical baselines unchanged, and does not place project-local content in default Knowns CI artifacts.

## Technical Notes

- Reuse the current benchmark foundation in `internal/search/benchmark.go` and canonical fixture location under `internal/search/testdata/`.
- Reuse the current retrieval response split between ranked candidates and `ContextPack`; do not add selection behavior in this spec.
- The exact CLI command hierarchy and internal package boundaries may follow existing CLI conventions during planning, provided the behavioral contract above remains unchanged.
- Semantic/hybrid fixture execution must be isolated from ordinary deterministic keyword CI and must record its pinned runtime identity.

## Task Links

- @task-7nh0ij — `[retrieval-contextpack-evaluation-gate-01]` Add versioned fixtures and ranked metrics
- @task-cers19 — `[retrieval-contextpack-evaluation-gate-02]` Evaluate ContextPack and emit reports
- @task-hgb39c — `[retrieval-contextpack-evaluation-gate-03]` Add CLI baseline regression gate
- @task-v43o31 — `[retrieval-contextpack-evaluation-gate-04]` Wire CI and pinned runtime verification

## Open Questions

None. D1–D13 define the MVP contract.
