---
id: doc-432c0839bf339f7de8cc523eb86bfee9
title: Keyword Search Benchmark Matrix
description: Benchmark matrix for evaluating current keyword search quality before considering BM25
createdAt: '2026-04-07T08:01:46.678Z'
updatedAt: '2026-04-07T08:04:39.232Z'
tags:
  - research
  - search
  - evaluation
  - benchmark
  - bm25
  - keyword
---

## Overview

Benchmark matrix for evaluating Knowns' current keyword search against real repository queries before deciding whether to replace or augment the lexical layer with BM25.

This doc is intended for manual evaluation first. It can later be turned into a repeatable test harness or quality suite.

Related references:
- @doc/specs/semantic-search
- @doc/specs/semantic-search-quality-improvements
- @doc/specs/rag-retrieval-foundation
- @task-prm29p
- @task-szd42a
- @task-x6db7x

## Goal

Measure where the current keyword heuristic succeeds or fails, especially in cases where BM25 would usually improve lexical retrieval quality.

Success means we can answer these questions with evidence:
- Are exact title/path matches already strong enough?
- Where do long docs or common terms distort ranking?
- Do tasks, docs, and memories rank sensibly for lexical-only queries?
- Which failure modes are frequent enough to justify BM25?

## How To Use This Matrix

For each query:
1. Run `knowns search "<query>" --keyword --plain` or equivalent keyword-only path.
2. Record the top 5 results by type, title/path, and rough quality.
3. Compare against the expected intent in this matrix.
4. Mark each query as one of:
   - `pass`: top 1-3 results match expectation
   - `partial`: relevant results exist but rank poorly or are mixed with noise
   - `fail`: expected result is missing or clearly outranked by weaker matches
5. Note the failure category.

Optional follow-up comparison:
- `knowns search "<query>" --plain`
- `knowns retrieve "<query>" --json`

Use those only after lexical evaluation so hybrid/retrieve does not hide keyword weaknesses.

## Failure Categories

- `common-term inflation`: generic words like `search`, `task`, `spec`, `guide` dominate ranking
- `long-doc bias`: long docs rank too well because they contain many matching words
- `substring noise`: substring matches outrank better whole-word matches
- `multi-word weakness`: bag-of-words handling is too weak for 2-5 term queries
- `title underweight`: exact or near-exact title matches do not dominate enough
- `path underweight`: path-encoded intent is not ranked strongly enough
- `task/doc skew`: one source type dominates even when another is clearly better
- `memory under-rank`: memory entries are present but rank below weaker docs/tasks
- `code leakage`: code-like hits pollute non-code keyword intent
- `explanation mismatch`: snippet does not reflect why the item ranked highly

## Benchmark Matrix

### Group 1: Exact Title and Path Lookup

| Query | Expected Strong Results | Why It Matters | Failure Categories |
|---|---|---|---|
| `semantic search` | `@doc/specs/semantic-search`, `guides/semantic-search-guide` | Tests exact title and spec/guide lookup | `title underweight`, `common-term inflation` |
| `rag retrieval foundation` | `@doc/specs/rag-retrieval-foundation` | Tests exact approved spec lookup | `title underweight`, `multi-word weakness` |
| `3 layer memory system` | `@doc/specs/3-layer-memory-system`, learning doc | Tests phrase variation without punctuation | `multi-word weakness`, `common-term inflation` |
| `guides/semantic-search-guide` | doc path should rank at or near top | Tests path-aware lookup | `path underweight` |
| `knowns-go rewrite` | `@doc/specs/knowns-go-rewrite` | Tests dashed title/path lookup | `substring noise`, `title underweight` |

### Group 2: Common-Term Queries

| Query | Expected Strong Results | Why It Matters | Failure Categories |
|---|---|---|---|
| `search` | search specs/guides/tasks, but not arbitrary docs with incidental mentions | Stress test for common-term inflation | `common-term inflation`, `long-doc bias` |
| `task` | task-related guides/specs/tasks, not any long doc mentioning task repeatedly | Generic lexical noise test | `common-term inflation`, `task/doc skew` |
| `memory` | memory system spec and memory-related docs/tasks | Checks whether generic domain term still surfaces relevant memory docs | `common-term inflation`, `memory under-rank` |
| `spec` | approved specs should dominate over random docs mentioning specification once | Tests generic repo vocabulary | `common-term inflation`, `long-doc bias` |

### Group 3: Multi-Word Intent

| Query | Expected Strong Results | Why It Matters | Failure Categories |
|---|---|---|---|
| `search quality improvements` | `@doc/specs/semantic-search-quality-improvements`, related task(s) | Tests multi-word lexical intent | `multi-word weakness`, `title underweight` |
| `memory entries search integration` | `@task-szd42a` and memory search references | Tests task lookup through descriptive phrase | `task/doc skew`, `multi-word weakness` |
| `heuristic reranker search pipeline` | `@task-x6db7x` | Tests whether implementation tasks can win over broader docs | `task/doc skew`, `title underweight` |
| `chunking strategies research` | `@doc/research/rag-chunking-strategies-research` | Tests research doc specificity | `multi-word weakness`, `path underweight` |

### Group 4: Source-Type Balance

| Query | Expected Strong Results | Why It Matters | Failure Categories |
|---|---|---|---|
| `retrieval orchestration` | retrieval tasks and retrieval spec should both appear, with the most exact item first | Tests doc/task balance | `task/doc skew` |
| `decision memory` | relevant memory entries should appear competitively, not always below docs/tasks | Tests memory lexical ranking | `memory under-rank` |
| `graph code ux` | `@doc/research/research-graph-code-ux` should outrank generic graph docs | Tests specialized research docs against broad docs | `long-doc bias`, `multi-word weakness` |

### Group 5: Substring and Token Boundary Risk

| Query | Expected Strong Results | Why It Matters | Failure Categories |
|---|---|---|---|
| `rag` | rag-specific docs should rank, but false positives from incidental substring use should be limited | Tests short-token noise | `substring noise`, `common-term inflation` |
| `plan` | planning docs/tasks should rank, but arbitrary implementation-plan mentions should not dominate | Tests substring-heavy term | `substring noise`, `long-doc bias` |
| `init` | init docs/commands should rank, not every word containing `init` in code-like text | Tests short token boundary handling | `substring noise` |

## Evaluation Sheet Template

Use this table while testing:

| Query | Top 1 | Top 2 | Top 3 | Verdict | Failure Category | Notes |
|---|---|---|---|---|---|---|
| example | spec/doc/task | ... | ... | pass/partial/fail | common-term inflation | short note |

## Initial Recommendations

Interpretation guide:
- If most failures are `common-term inflation` and `long-doc bias`, BM25 is a strong candidate.
- If most failures are `task/doc skew` or `memory under-rank`, fix source-aware ranking before replacing lexical scoring.
- If most failures are `substring noise`, tighten token-boundary logic first.
- If exact title/path queries already perform very well, preserve those boosts even if BM25 is added.

Recommended rollout order:
1. Run this matrix on current keyword-only search.
2. Summarize failures by category.
3. Decide whether to:
   - refine heuristics only
   - add BM25 as an alternative lexical backend
   - replace current keyword scoring
4. Re-run the same matrix after changes.

## Open Questions

- [ ] Should this benchmark stay manual, or be converted into a golden-file regression suite?
- [ ] Should we evaluate `search` and `retrieve` separately once lexical quality is stable?
- [ ] If BM25 is added, should exact title/path boosts remain as a rerank layer on top of BM25?

## First Pass Results (2026-04-07)

Ran a manual first pass against current keyword-only search using `go run ./cmd/knowns search "<query>" --keyword --plain`.

### Verdict Summary

| Query | Verdict | Notes |
|---|---|---|
| `semantic search` | pass | Exact spec and guide rank strongly near the top. |
| `rag retrieval foundation` | pass | Exact spec ranks first; related tasks follow sensibly. |
| `3 layer memory system` | pass | Core spec and learning doc rank strongly. |
| `guides/semantic-search-guide` | pass | Path lookup works well. |
| `knowns-go rewrite` | partial | Target spec ranks high, but benchmark doc self-pollution appears above other relevant items. |
| `search` | fail | Very noisy; broad search-related docs/tasks dominate. Strong signal for common-term inflation. |
| `task` | fail | Extremely noisy and generic; task-specific intent is not separated well. |
| `memory` | partial | Relevant memory docs/tasks do rank, but generic memory-related tasks flood results. |
| `spec` | fail | Generic spec term returns many specs with weak differentiation. |
| `search quality improvements` | pass | Correct spec ranks first. |
| `memory entries search integration` | partial | Correct task ranks first, but benchmark/self-reference noise and broad memory/search tasks appear too strongly. |
| `heuristic reranker search pipeline` | partial | Correct task ranks first, but benchmark doc and broad search docs still intrude. |
| `chunking strategies research` | pass | Target research doc ranks first. |
| `retrieval orchestration` | pass | Correct retrieval task ranks first and retrieval spec is visible. |
| `plan` | fail | Short token is dominated by substring/generic plan-related noise. |

### Category Summary

Most visible failure categories in this first pass:
- `common-term inflation`
- `substring noise`
- `long-doc bias`
- `task/doc skew`

### Important Benchmarking Caveat

This benchmark doc itself now contains many benchmark query strings. As a result, `research/keyword-search-benchmark-matrix` self-pollutes several lexical queries and should be treated as benchmark noise rather than a real relevant result.

If this matrix is reused often, consider one of:
- moving raw query strings into a machine-readable fixture outside doc search scope
- excluding benchmark docs during lexical evaluation
- converting the benchmark into a golden test harness instead of prose-first evaluation
