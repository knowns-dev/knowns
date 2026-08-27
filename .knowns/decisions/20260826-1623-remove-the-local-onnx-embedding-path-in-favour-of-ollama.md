---
id: 20260826-1623-remove-the-local-onnx-embedding-path-in-favour-of-ollama
title: Remove the local ONNX embedding path in favour of Ollama
status: draft
supersedes: []
supersededBy: []
tags:
  - embedding
  - search
  - breaking
  - removal
sources:
  - '@doc/specs/2026-08-24/ollama-only-embedding'
  - commit f295e30
relatedDocs:
  - specs/2026-08-24/ollama-only-embedding
  - specs/semantic-search
  - specs/openai-compatible-embedding-provider
  - specs/multi-store-semantic-memory-retrieval
  - specs/semantic-search-quality-improvements
  - features/model-command
  - guides/semantic-search-guide
relatedTasks:
  - OLM-CC04VN
  - OLM-H9PKPY
  - OLM-AKEN95
  - OLM-PT1BX4
  - OLM-JF91HA
  - OLM-2MWBPF
  - OLM-XJKSB7
  - OLM-K4NHTY
verification: []
reviewState: needs_evidence
reviewBlockers:
  - 'linked task "OLM-H9PKPY" is "in-progress"; all linked tasks must be done before accepting candidate'
reviewMatches: []
reviewAllowedResolutions: []
reviewEvaluatedAt: '2026-08-26T09:23:53.361Z'
createdAt: '2026-08-26T09:23:53.361Z'
updatedAt: '2026-08-26T09:23:53.361Z'
---

## Context

Knowns embedded text two ways: a local ONNX runtime linked into the binary, and an OpenAI-compatible HTTP provider (Ollama or a third-party endpoint).

The ONNX path carried a 35 MB platform-specific shared library that the release pipeline downloaded for five platform/arch pairs, a runtime loader probing five filesystem locations that had to arch-match whatever it found, a `knowns model` command tree for downloading and managing models, and a tokenizer implementation used by nothing else. It was already unavailable on macOS Intel, because ONNX Runtime stopped shipping a compatible prebuilt x86_64 macOS library — so the "works everywhere" property the bundled path was supposed to buy had already lapsed on one platform.

Maintaining two embedding paths meant every downstream decision carried a legacy branch, and the quality work needed to make the HTTP provider competitive had already been done separately.

## Decision

Remove the local ONNX embedding path. The OpenAI-compatible HTTP provider becomes the only way Knowns embeds text, with Ollama as the recommended local implementation.

Ollama is still local: embedding runs on the user's machine and text never leaves it. What changes is the shape of the dependency — from a library linked into the binary to a service the user installs and runs.

The load-bearing sub-decisions:

- **`provider: local` resolves, it does not rewrite.** A project declaring `provider: local` is read as `provider: ollama` with the default model, automatically and on every read. The file on disk changes only under an explicit `knowns migrate`. Resolution must be automatic or every downstream path needs the legacy branch the removal exists to delete. Writing must not be, because `.knowns/config.json` is committed: a rewrite triggered by `knowns task list` puts a change in someone's working tree that they neither asked for nor made.

- **Keyword results are returned whenever semantic retrieval fails operationally.** An unreachable embedder degrades search; it does not fail it. The ONNX path hid a real bug here — `hybridSearch` computed keyword results and returned them alongside the error, and `Search` discarded them — because a locally loaded library is rarely unreachable. Once Ollama is the only path, "installed but not running" is an ordinary state and that bug becomes the common failure.

- **`knowns model` is removed rather than reimplemented against Ollama.** Users pull with `ollama pull` and select with `knowns config`. Reimplementing it would have made Knowns a second, worse front-end for a model store Ollama already manages well.

- **Migration marks the index stale and stops.** It does not reindex. Search serves keyword results until the user runs an explicit reindex, because reindexing a large repository is not something a config migration should decide to spend someone's machine on.

- **Detection may narrow the configuration, never widen it.** `init` and `setup` disable semantic search when no Ollama is reachable, because the alternative is a project declaring an embedder it cannot use. They never enable it merely because Ollama is present: `.knowns/config.json` is git-tracked, so deciding from machine state writes one developer's laptop into everyone's repository. An interactive run may preselect and explain; it may not decide.

- **One shared source renders the Ollama guidance** for setup, `doctor`, `init`, and the published documentation, so the recommended model set cannot drift between them.

## Alternatives Considered

**Keep both paths.** Rejected: it preserves exactly the legacy branching the removal exists to delete, and keeps a 35 MB per-platform binary dependency in the release pipeline for a path that was already broken on macOS Intel.

**Reimplement `knowns model` against Ollama.** Rejected: it would duplicate a model store Ollama already manages, and put Knowns in the business of tracking pull state it does not own. `ollama pull` plus `knowns config` covers the same ground with no new surface. The discovery role `knowns model` played — showing users which models exist and why to pick one — is replaced by the shared guidance source (D6), which is where that information belonged anyway.

**Rewrite `provider: local` configs automatically on read.** Rejected: `.knowns/config.json` is tracked, so a silent rewrite during an ordinary read command dirties a working tree without the user's involvement. The repository already draws this line — history migrations run silently against git-ignored state, while `knowns decision migrate` is explicit because `.knowns/decisions/` is tracked.

**Reindex during migration.** Rejected in favour of marking the index stale: a migration should not unilaterally spend minutes of a user's machine, and keyword results remain available meanwhile.

**Enable semantic search when Ollama is detected at init.** Rejected: it writes machine state into a tracked file, so one developer's laptop configures the whole team's repository.

## Consequences

**Breaking for users.** `knowns model` no longer exists. Semantic search now requires Ollama (or another OpenAI-compatible endpoint) to be installed and running; it is no longer satisfied by the binary alone. Projects on `provider: local` keep working — the value is resolved on read — but should run `knowns migrate --write`, and must reindex explicitly afterward because the migration only marks the index stale.

**Simpler distribution.** The release pipeline downloads and bundles nothing per platform; every archive is just the binary. CGO is no longer required — `onnxruntime_go` was the only package in the module needing a C toolchain — so every target builds with `CGO_ENABLED=0`. macOS Intel stops being a special case, since the thing it lacked no longer exists anywhere.

**Token counting is now estimated, not exact.** The tokenizer was removed with the ONNX path, and it was the only exact implementation. This is a knowing downgrade of `@doc/specs/semantic-search-quality-improvements` FR-3, recorded as a deliberate override rather than absorbed silently. Chunk sizing now follows the embedder's reported context limit instead of a hardcoded table, which is more accurate in the dimension that matters more.

**Automatic reindex on dimension change is dropped**, overriding `@doc/specs/openai-compatible-embedding-provider` FR-12 (D5). Also recorded as a deliberate override.

**A CI gate is temporarily unarmed.** The pinned retrieval evaluation's committed baselines named the removed ONNX runtime and can never validate against the new pin, so they were deleted. Semantic and hybrid retrieval quality is not gated until the baselines are regenerated on the linux-x64 runner via `workflow_dispatch` and committed. The workflow emits an explicit warning each run so the gap cannot pass for a passing gate.

**Supersedes.** `@doc/features/model-command` in full. Partially: `@doc/specs/semantic-search`, `@doc/specs/openai-compatible-embedding-provider`, `@doc/specs/multi-store-semantic-memory-retrieval`, `@doc/specs/semantic-search-quality-improvements` — each records its own void/retained split.

**Evidence.** Commit `f295e30` — 76 files, +1731 / −6451, removing `internal/search/{embedding_native,embedding_common,onnx_capability,onnx_runtime,tokenizer}.go` and `internal/cli/{model,download_setup}.go`. Full test suite, `go vet`, and `knowns validate --scope sdd` pass on that commit.

**Status: draft.** Per the spec's own acceptance gate, this Decision stays draft and is not accepted in this wave.
