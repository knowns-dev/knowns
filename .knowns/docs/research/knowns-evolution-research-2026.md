---
title: Knowns Evolution Research 2026
description: 'Paper-backed research on the next product and architecture directions for Knowns: measurable retrieval, budgeted context, temporal/provenance-aware memory, evidence graphs, secure consolidation, and adaptive workflows.'
createdAt: '2026-07-23T04:23:57.854Z'
updatedAt: '2026-07-24T14:34:21.693Z'
tags:
  - research
  - rag
  - retrieval
  - memory
  - agents
  - graph
  - evaluation
  - security
  - roadmap
---

# Knowns Evolution Research 2026

## Executive Conclusion

Knowns does not need another generic RAG stack, vector database, wiki layer, or autonomous memory rewriter. Its core primitives are already unusually complete: local-first canonical Markdown, docs/tasks/memories/decisions, hybrid BM25 + semantic search, cited ContextPacks, typed structural traversal, runtime memory hooks, LSP code intelligence, lifecycle-aware retrieval, and review-gated knowledge writes.

The highest-leverage direction is to turn these primitives into a **measurable evidence and learning control plane**:

`retrieve -> plan -> change -> verify -> learn`

The most important missing capabilities are:

1. objective retrieval and context-pack evaluation;
2. token-budgeted, diversity-aware context assembly;
3. retrieval traces and feedback loops;
4. temporal validity and provenance-aware trust;
5. evidence paths that connect specs, tasks, code, tests, and decisions;
6. secure, review-gated consolidation of task episodes into durable knowledge.

The recommended order is **measure first, bound context second, harden memory third, then add adaptive graph/workflow intelligence**.

## Method

This research followed Knowns' local-first discovery order:

- project docs, tasks, and memories;
- current code paths and tests;
- then primary papers, standards, and official repositories.

The proposal is constrained by the current design philosophy in @doc/architecture/overview: CLI-first, local-first, AI-ready, file-backed, and multi-access. It also preserves the decisions in:

- @doc/specs/rag-retrieval-foundation
- @doc/specs/structural-knowledge-retrieval
- @doc/specs/2026-06-18/memory-decision-review-ui
- @doc/specs/runtime-memory-hook-injection
- @doc/specs/2026-07-21/task-lifecycle-context-hygiene
- @doc/specs/2026-07-23/decision-taxonomy-workflow-enforcement
- @doc/research/knownedge-team-knowledge-server

## Current Baseline and Concrete Gaps

### Reusable foundations

- `internal/search/engine.go` already supports keyword, semantic, hybrid RRF, heuristic reranking, trusted Memory/Decision filtering, docs-first retrieval, citations, and optional reference expansion.
- `internal/search/benchmark.go` plus `internal/search/testdata/keyword_benchmark_cases.json` already provide a golden-test entry point.
- `internal/storage/structural_traversal.go` already performs bounded typed BFS traversal with direction, relation filters, entity filters, edge origin, and unresolved-edge reporting.
- `internal/runtimememory/runtimememory.go` already emits bounded memory packs with scores, reasons, matched-by metadata, capture outcomes, and runtime adapters.
- `internal/mcp/audit.go` and the audit store already provide privacy-aware JSONL tool-call auditing, so new retrieval traces can extend an existing observability substrate.
- @doc/specs/2026-07-24/decision-processing-flow now persists System Decision candidates, requires explicit Decision impact at workflow completion, preserves task/spec/source provenance, and separates Current, Review Inbox, History, and Legacy Migration surfaces.
- Memory review now separates Trusted, Review Inbox, and History in WebUI; missing-source repair can stage ranked doc/task suggestions for confirmed persistence; active Memories can be archived out of default retrieval while remaining in History.
- Memory review, Decision lifecycle, task archive/reopen, and LSP diagnostics provide the governance and verification boundaries needed for the proposals below.

### Gaps verified in code

1. `RetrievalOptions` and `ContextPack` have no token budget, used-token count, dropped-item list, or pack sufficiency signal.
2. `buildContextPack` generally loads full source content after source-level ranking. `Limit` limits direct search results, not necessarily the final size after reference expansion.
3. Reference expansion is boolean and assigns expanded records a fixed `source.Score * 0.5`; it is not query-conditioned, diversity-aware, path-aware, or budget-aware.
4. The benchmark uses `pass/partial/fail` and expected IDs but has no graded relevance, nDCG, MRR, Recall@K, source coverage, context-pack recall, latency distribution, or stale-source error rate.
5. Hybrid retrieval exposes final scores and `matchedBy`, but not per-stage scores, RRF contribution, rerank delta, route reason, expansion path, token cost, or drop reason.
6. Memory includes `LastVerified`, `TTLDays`, `Sources`, and `Confidence`, but default eligibility mainly checks `status=active`; TTL and verification age do not directly remove or warn on an item in normal retrieval.
7. Memory cleanup is age-based on `updatedAt`; touching an entry can reset its apparent freshness without proving its truth or usefulness.
8. Structural traversal returns flattened edges, not complete support paths, path scores, evidence coverage, or answerability/abstention signals.
9. Workflow completion now records explicit System Decision impact and can persist a candidate with originating task/spec/source provenance. Plans and acceptance criteria still remain mostly Markdown, however, and there is no machine-checkable evidence chain from each plan step or AC to impacted code, diagnostics, tests, and final Decision acceptance evidence.
10. Audit records tool calls, while implementation notes and Decision impact markers capture part of the final outcome. Knowns still does not retain a structured compact task episode containing goal, retrieved context, actions, failures, corrections, validation evidence, and outcome for later reviewed learning.

## Priority Matrix

| Priority | Workstream | Impact | Effort | Recommendation |
|---|---|---:|---:|---|
| P0 | Retrieval/context benchmark with qrels | Very high | Low-medium | Build now |
| P0 | Token-budgeted ContextPack | Very high | Medium | Build now |
| P0 | Retrieval trace + memory injection security | Very high | Medium | Build now |
| P1 | Temporal validity + provenance-aware trust | Very high | Medium-high | Build after P0 |
| P1 | Lightweight Memory Doctor + reviewed deduplication | High | Medium | Build on existing review primitives |
| P1 | Evidence-path retrieval + impact-aware planning | Very high | High | Build after P0 |
| P2 | Adaptive routing and graph reranking | High | Medium-high | Shadow experiment |
| P2 | Episodic-to-semantic consolidation | High | Medium | Reviewed experiment |
| P3 | Actor/audience-scoped team memory | High | High | Knownedge, not core |

## Recommended Workstreams

### 1. Retrieval and ContextPack Evaluation as a Product Gate — P0

#### Research basis

[MTEB](https://aclanthology.org/2023.eacl-main.148/) and [BEIR](https://datasets-benchmarks-proceedings.neurips.cc/paper/2021/hash/65b9eea6e1cc6bb9f0cd2a47751a186f-Abstract-round2.html) show why retrieval systems need multiple tasks, domains, and ranked metrics rather than a single aggregate verdict. [RAGChecker](https://proceedings.neurips.cc/paper_files/paper/2024/hash/27245589131d17368cccdfa990cbf16e-Abstract-Datasets_and_Benchmarks_Track.html) motivates stage-specific diagnostics instead of only judging final output. [BRIGHT](https://arxiv.org/abs/2407.12883) shows that reasoning-intensive retrieval is materially harder than surface semantic matching.

#### MVP

Extend the current benchmark fixture with graded qrels (`0..3`) and query categories:

- exact ID/title/path lookup;
- conceptual explanation;
- current Decision/policy;
- failure/pattern recall;
- temporal update and stale-knowledge avoidance;
- multi-hop evidence;
- null/abstention;
- code localization and impact.

Report:

- nDCG@10, MRR@10, Recall@5/10/20, Success@K;
- candidate recall versus final ContextPack recall;
- support-chain recall for multi-hop queries;
- citation correctness and stale-source rate;
- context tokens/bytes and redundancy;
- p50/p95 latency, grouped by category, source, mode, and language.

Keep the current verdict summary for compatibility. Store raw benchmark queries in fixtures outside normal search scope to prevent self-pollution.

#### Why now

Every later change—budgeting, routing, graph expansion, reranking, temporal filtering—can silently lose recall. No adaptive feature should ship before this gate exists.

### 2. Token-Budgeted, Diversity-Aware ContextPack — P0

#### Research basis

[Lost in the Middle](https://arxiv.org/abs/2307.03172) shows that longer context is not automatically better. [RECOMP](https://proceedings.iclr.cc/paper_files/paper/2024/hash/bda88ed2892f5e61c9a9bf215c566913-Abstract-Conference.html) demonstrates selective augmentation and context compression. [DF-RAG](https://arxiv.org/abs/2601.17212) is early 2026 evidence that query-adaptive diversity can improve reasoning-heavy retrieval, but should remain an experiment until it wins on Knowns' benchmark.

#### MVP

Add to `RetrievalOptions` and `ContextPack`:

- `MaxTokens`, `UsedTokens`, `BudgetModel`;
- selected and dropped candidates with reasons;
- truncation/partial-content metadata;
- pack sufficiency/coverage metadata;
- per-source soft quota, not a hard docs-first partition.

Select content at section/chunk granularity using a deterministic greedy objective such as:

`marginal utility = relevance + direct-match + evidence-coverage - redundancy - trust/staleness penalty`, normalized by token cost.

Preserve original excerpts and citations. Do not introduce abstractive compression in the core path. Use the existing tokenizer interface with a conservative fallback.

#### Compatibility constraint

Docs-first remains a preference, but it should become a soft bias under a budget; otherwise an entire document can starve a highly relevant Decision, Task, or Memory.

### 3. Retrieval Trace and Memory Injection Security — P0

#### Research basis

OpenTelemetry has emerging [GenAI retrieval span conventions](https://github.com/open-telemetry/semantic-conventions/blob/main/model/gen-ai/spans.yaml), while Knowns already has a local JSONL audit substrate. Recent work on [memory poisoning](https://arxiv.org/abs/2606.04329) finds that aggressive memory write/retrieval increases exploitability and that existing prompt-injection defenses do not cover the full memory threat. The July 2026 [Bad Memory](https://arxiv.org/abs/2607.14611) preprint specifically reports cross-session attacks from malicious content already planted in agent memory files. [MEXTRA](https://aclanthology.org/2025.acl-long.1227/) shows that agent memory also creates extraction/privacy risks.

#### Retrieval trace MVP

Create an opt-in, privacy-safe trace for each retrieval:

- query hash by default; raw query only with explicit capture;
- lexical and semantic top-N;
- RRF contribution and heuristic rerank delta;
- route/mode reason;
- expansion edge/path;
- selection and drop reason;
- candidate and pack token counts;
- stage latency and runtime degradation;
- consumer task/session ID when available.

Store local JSONL first. Make future OpenTelemetry export optional.

#### Memory security MVP

At write and pre-injection composition time:

- scan for secret/PII and instruction-like payloads;
- preserve untrusted/proposed status as quarantine;
- serialize retrieved memories as data/facts, never authoritative instructions;
- add sensitivity, purpose, owner/source, retention, and audience metadata where known;
- deny or require review for low-trust/high-risk injection;
- record which memories were injected without recording their full private content by default.

This work should precede richer automatic consolidation.

### 4. Temporal Validity and Provenance-Aware Trust — P1

#### Research basis

[LongMemEval](https://arxiv.org/abs/2410.10813) evaluates extraction, multi-session reasoning, temporal reasoning, knowledge updates, and abstention; its time-aware query expansion is directly relevant. [Zep/Graphiti](https://arxiv.org/abs/2501.13956) demonstrates the value of temporally aware relationships and retained history. [W3C PROV-O](https://www.w3.org/TR/prov-o/) provides a stable Entity–Activity–Agent vocabulary for interoperable provenance.

#### MVP 1: enforce existing metadata

Before adding fields, make current `TTLDays`, `LastVerified`, `Sources`, and `Confidence` operational:

- expired active memories are withheld, warned, or queued for review;
- high-use but old memories request revalidation rather than becoming immortal;
- cleanup distinguishes validity, retention, and utility;
- `updatedAt` no longer acts as proof of truth.

#### MVP 2: bitemporal claims

Add optional claim-level or record-level fields:

- `validFrom` / `validUntil`: when the claim was true;
- `observedAt` / `ingestedAt`: when Knowns learned it;
- `derivedFrom`, `primarySource`, `revisionOf`;
- typed links `supports`, `contradicts`, `supersedes`.

Default retrieval uses `asOf=now`; historical retrieval is explicit. Contradiction resolution closes the prior validity interval and retains history instead of deleting it.

Trust should remain explainable features, not one opaque scalar truth score.

### 5. Evidence-Path Retrieval and Impact-Aware Planning — P1

#### Research basis

[HippoRAG](https://papers.nips.cc/paper_files/paper/2024/hash/6ddc001d07ca4f319af96a3024f6dbd1-Abstract-Conference.html) uses graph retrieval plus Personalized PageRank for multi-hop integration. [RepoGraph](https://arxiv.org/abs/2410.14684) reports gains when repository graphs guide software-engineering systems. [CodePlan](https://www.microsoft.com/en-us/research/publication/codeplan-repository-level-coding-using-llms-and-planning/) combines incremental dependencies, change may-impact analysis, and adaptive planning; in its small evaluation it passed validity checks on 5/6 repositories while the no-planning baseline passed none.

#### Retrieval MVP

Keep text/hybrid search as seed generation. For relationship-heavy queries, add an opt-in evidence-path mode:

- bounded 1–2 hop path or light PPR ranking;
- typed relation/direction/origin weights;
- trust, lifecycle, and recency filters;
- token-budget pruning;
- complete support paths in the ContextPack;
- counterevidence and unresolved edges;
- `insufficient evidence` / answerability signal.

This directly answers the current open question in @doc/specs/structural-knowledge-retrieval about returning full traversal paths.

#### Planning MVP

Represent a task plan as a thin evidence DAG, initially as a derived/read-only view:

- plan step -> spec Decision / AC;
- plan step -> code symbol/file;
- prerequisite and may-impact edges;
- expected diagnostic/test/validation evidence;
- uncovered impact and unresolved targets.

Use LSP references, definitions, implementations, and diagnostics on demand; do not rebuild a persistent full code graph as canonical truth. After each edit, refresh impacted nodes and validation coverage.

### 6. Adaptive Routing and Optional Reranking — P2 Experiment

#### Research basis

[Adaptive-RAG](https://aclanthology.org/2024.naacl-long.389/) routes queries by complexity. [Agentless](https://arxiv.org/abs/2407.01489) is a useful counterweight for coding agents: a simple localization -> repair -> validation pipeline can outperform more complex autonomous systems. This aligns with Knowns' explicit research/plan/implement/review/verify workflows.

#### Shadow-mode MVP

Start with deterministic routing and record the proposed route without changing results:

- ID/path/quoted/exact query -> keyword-heavy;
- natural-language conceptual query -> hybrid;
- relation/impact/multi-hop query -> hybrid seed + structural paths;
- timeline/history query -> temporal expansion;
- tiny, low-risk task -> shorter workflow;
- broad or high-risk change -> full evidence-gated workflow.

Only activate a route after it improves benchmark quality and latency. Do not train a classifier before trace and qrels exist.

A small local cross-encoder may be tested on top-20 candidates later, but it must be optional, measured, multilingual-aware, and fail back to the current heuristic reranker.

### 7. Reviewed Episodic-to-Semantic Consolidation — P2 Experiment

#### Research basis

[Agent Workflow Memory](https://proceedings.mlr.press/v267/wang25bx.html) extracts reusable workflows from agent experience. [Reflexion](https://papers.neurips.cc/paper_files/paper/2023/hash/1b44b878bb782e6954cd888628510e90-Abstract-Conference.html) uses episodic verbal feedback. [CoALA](https://arxiv.org/abs/2309.02427) distinguishes episodic, semantic, and procedural memory. [ACE](https://arxiv.org/abs/2510.04618) treats context as an incrementally curated playbook rather than repeatedly rewriting a summary.

#### MVP

Capture a compact task episode linked to its task and evidence:

- goal and constraints;
- retrieved evidence IDs;
- action/tool and observation;
- failure signature and correction;
- diagnostics/tests/validation outcome;
- final result and commit/patch reference when available.

At task completion, cluster related episodes and create a **consolidation proposal**:

- candidate Pattern/Failure/Procedure Memory or draft System Decision;
- evidence list and success/failure counts;
- suggested merge/archive/keep-separate action;
- no automatic activation and no in-place rewrite of trusted records.

This extends the current durable-knowledge warning into a learning loop without violating review gates.

### 8. Team/Group Memory Belongs in Knownedge — P3

Actor, audience, workspace, object-level permissions, retention, and organization-wide knowledge should remain in the separate product direction described in @doc/research/knownedge-team-knowledge-server. Core Knowns should expose the local primitives and client integration, not absorb tenancy, server-grade vector infrastructure, or enterprise RBAC.

## Anti-Goals

1. **Do not replace Knowns retrieval with generic context compression.** @memory/bcjleq already establishes Headroom as optional runtime inspiration, not a retrieval replacement.
2. **Do not build another wiki as the core.** @memory/01j7ng already classifies LLM Wiki as workflow/UX inspiration over existing primitives.
3. **Do not auto-rewrite active trusted memories.** A-MEM and Mem0 are useful research references, but autonomous in-place evolution conflicts with Knowns' auditability, canonical docs/tasks/Decisions, and review gates. Only proposed deltas, merges, or supersession should be automated.
4. **Do not make LLM judges or Self-RAG calls part of core `retrieve`.** Knowns does not own the generation model; runtime LLM calls would weaken local-first determinism, privacy, and latency. Keep optional judges offline.
5. **Do not build full GraphRAG community summaries as canonical knowledge.** If ever tested, summaries must be derived, disposable, versioned, and source-backed.
6. **Do not add a new vector database merely to appear more scalable.** The verified gaps are measurement, budgeting, trust, paths, and workflow evidence—not vector storage.
7. **Do not use multi-agent orchestration by default.** Complexity should be justified by a measurable win over the simple phased baseline.

## Recommended Delivery Sequence

### Phase A — Measurement and safety substrate

1. Add qrels and ranked retrieval/context metrics.
2. Add opt-in privacy-safe retrieval traces on the existing audit substrate.
3. Add memory injection security and privacy regression cases.

Exit gate: reproducible benchmark, stage-level diagnosis, and no unreviewed unsafe memory injection.

### Phase B — Bounded and trustworthy context

1. Add `MaxTokens`, selection/drop reasons, and ContextPack accounting.
2. Select section/chunk evidence with diversity and soft source quotas.
3. Enforce existing TTL/verification/source trust metadata.

Exit gate: higher or equal support recall under a predictable context budget and no increase in stale-memory errors.

### Phase C — Evidence control plane

1. Add support paths, counterevidence, and abstention.
2. Add temporal/provenance fields and historical `asOf` retrieval.
3. Add derived impact-aware plan DAG and validation coverage.

Exit gate: measurable multi-hop/impact improvement and inspectable proof chains.

### Phase D — Controlled learning experiments

1. Shadow adaptive routing.
2. Optional graph/PPR reranking.
3. Reviewed episodic-to-semantic consolidation.
4. Optional local semantic reranker.

Exit gate: each feature ships only if it beats the simple baseline on quality, latency, privacy, and local-resource budgets.

## Product Thesis

The defensible solution is not “a smarter search box” or “memory for agents.” It is a local-first system that can answer:

- What context was selected, and why?
- What was dropped to fit the budget?
- Is this knowledge current, trusted, and valid at the requested time?
- Which evidence path supports the answer or planned change?
- Which code and tests may be affected?
- What verification proves completion?
- What reusable lesson can be proposed without silently rewriting trusted knowledge?

That is the path from a strong collection of primitives to a complete, inspectable agent-development solution.


## Lightweight Memory Doctor and Reviewed Deduplication — P1

Memory hygiene should become an explicit, bounded workflow rather than an always-on background service. The goal is to reduce duplicate, stale, contradicted, low-trust, and low-value memories without turning Knowns into an autonomous knowledge rewriter or imposing a persistent resource tax.

This workstream builds on @doc/specs/memory-auto-cleanup and @doc/specs/2026-06-18/memory-decision-review-ui.

### Current substrate and verified gaps

Knowns already provides useful primitives:

- `memory cleanup` returns age-based candidates;
- new Memory writes run lexical and semantic duplicate review;
- review resolutions include `update_existing`, `archive_existing_create_new`, `create_proposed`, `reject_new`, and `merge_existing`;
- `merge_existing` preserves a duplicate as a `merged` tombstone with `mergedInto` provenance;
- deletion is previewable through dry-run and removed records are also removed from the search index;
- non-active records do not enter default retrieval;
- WebUI separates active Trusted Memories, unresolved Review Inbox items, and historical outcomes into distinct lifecycle destinations;
- missing or broken sources can receive a bounded ranked set of current doc/task suggestions, but persistence remains staged, review-gated, and confirmation-bound;
- an active Memory can be deliberately archived out of default retrieval while preserving its content and provenance in History.

The remaining gaps are important:

- cleanup currently treats age as the primary signal, even though old knowledge may remain durable and valuable;
- there is no bounded batch deduplication workflow for memories already in the store;
- the current WebUI supports individual lifecycle and source-repair actions, but it does not provide a bounded Memory Doctor pass or grouped duplicate review;
- `merge_existing` records canonical ownership but does not synthesize candidate content, tags, or sources into the target;
- source suggestions improve repair ergonomics but do not classify truth, utility, contradiction, verification age, retrieval use, or replacement evidence;
- CLI users do not yet have a first-class `memory review`, `memory merge`, or `memory doctor` workflow.

### Proposed Memory Doctor workflow

Expose a preview-first command such as:

```bash
knowns memory doctor --dry-run --older-than 30 --limit 50
```

The command should produce review groups and proposed actions, never silently mutate active knowledge:

| Detection | Default proposal |
|---|---|
| Exact duplicate | Merge into an explicitly selected canonical Memory |
| Semantically equivalent with better evidence | Update canonical after review |
| Superseded guidance | Archive old and create or activate replacement |
| Contradictory active guidance | Require manual resolution and preserve both evidence trails |
| Expired or unverified | Mark stale or request revalidation |
| Missing source / low confidence | Keep proposed or quarantine from default retrieval |
| Clear junk or malformed capture | Propose rejection or deletion |

Canonical selection must be explicit and explainable. Deterministic merge operations may union unique tags and source references, but free-form content synthesis should remain a proposal requiring review. Duplicate records should become tombstones pointing at the canonical entry so historical refs and auditability are preserved.

### Resource and safety envelope

Memory Doctor must follow the same local-resource product constraint as retrieval and LSP intelligence:

- run only on explicit request; no default background sweep;
- perform exact hash, normalized title, source, and tag checks before semantic comparison;
- use indexed top-K neighbors for a bounded candidate set, never all-pairs `O(n²)` comparison;
- enforce hard limits for scanned records, semantic queries, elapsed time, concurrency, and output groups;
- support a keyword-only mode when semantic infrastructure is unavailable;
- reuse existing indexes and avoid creating another persistent graph or vector store;
- default to dry-run and require explicit confirmation for mutations;
- never auto-delete, auto-merge, or rewrite an active trusted Memory;
- journal changed IDs and preserve `mergedInto`, replacement, and source provenance;
- return partial results on timeout rather than blocking the CLI or agent session.

### Delivery slices

1. Expose the existing review resolutions through ergonomic CLI commands: `memory review`, `memory merge`, `memory reject`, and `memory archive-replace`.
2. Upgrade `memory cleanup` from age-only listing to previewable signals for TTL, verification age, provenance, confidence, and lifecycle.
3. Add a bounded `memory doctor --dry-run` pass using exact and lexical grouping.
4. Add optional semantic top-K grouping using the existing memory index.
5. Add deterministic metadata/source union and content-consolidation proposals, while keeping trusted-content edits review-gated.

### Evaluation gate

Track reviewer acceptance rate, false-merge rate, duplicate reduction, stale-memory retrieval rate, ContextPack redundancy, p50/p95 latency, peak memory, and index growth. The workflow should ship only if it improves retrieval hygiene without materially slowing normal commands or adding idle resource usage.
