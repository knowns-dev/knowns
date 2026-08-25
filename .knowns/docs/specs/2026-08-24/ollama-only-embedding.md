---
id: doc-0dfd45b6feea4bba84a7494c34281465
title: Ollama-Only Embedding
description: Specification for removing the local ONNX embedding path, migrating projects to Ollama, and making keyword fallback survive an unreachable embedder
createdAt: '2026-08-24T11:05:37.755Z'
updatedAt: '2026-08-24T18:53:36.398Z'
tags:
  - spec
  - draft
  - review-required
  - embedding
  - search
  - breaking
---

## Overview

Knowns embeds text two ways: a local ONNX runtime loaded into the binary, and an
OpenAI-compatible HTTP provider (Ollama or a third-party endpoint). The ONNX path
carries a 35 MB platform-specific shared library that the release pipeline
downloads for five platform/arch pairs, a runtime loader that probes five
filesystem locations and must arch-match what it finds, a model download and
management command tree, and a tokenizer implementation used by nothing else.

This spec removes the local ONNX path. Ollama is also local: embedding still runs
on the user's machine and text never leaves it. What changes is the shape of the
dependency, from a library linked into the binary to a service the user installs
and runs.

Removing it makes the HTTP provider the only embedding path, so two things must
hold first. Its quality gaps must be closed, which was done separately and is
assumed here rather than restated. And keyword search must survive an embedder
that cannot be reached, which it currently does not: `hybridSearch` computes
keyword results and returns them alongside the error, and `Search` discards them.
Today the ONNX path hides that, because a locally loaded library is rarely
unreachable. Once Ollama is the only path, "installed but not running" becomes an
ordinary state, and the bug becomes the common failure.

Related: @doc/specs/openai-compatible-embedding-provider, @doc/specs/semantic-search

## Locked Decisions

- D1: A project configured with `provider: local` resolves as though it declared
  `provider: ollama` with the D2 default, automatically and on every read. The
  configuration file itself is rewritten only by an explicit `knowns migrate`.
  Resolution has to be automatic or every path downstream needs a legacy branch,
  which is the branch FR-1 exists to delete. Writing must not be, because
  `.knowns/config.json` is committed: a rewrite triggered by `knowns task list`
  puts a change in someone's working tree that they neither asked for nor made.
  The repository already draws this line — history migrations
  (`internal/storage/history_migration.go`) run silently against git-ignored
  state, while `knowns decision migrate` is explicit because `.knowns/decisions/`
  is tracked.
- D2: Three models are seeded into the global registry: `qwen3-embedding:0.6b`
  (default), `nomic-embed-text`, and `all-minilm`. All three are Apache-2.0 and
  Ollama-native. Seeding is not a convenience: `provider: ollama` resolves its
  dimensions through the global model registry, which is empty on a fresh
  machine, so without a seeded entry the first index fails to resolve the model.
- D3: Keyword results must be returned whenever semantic retrieval fails for an
  operational reason. An unreachable or failing embedder degrades the search, it
  does not fail it.
- D4: The `knowns model` command tree is removed rather than reimplemented
  against Ollama. Users pull models with `ollama pull` and select one with
  `knowns config`. The recommended set from D2 surfaces through the guidance in
  D6 instead.
- D5: Migration marks the existing semantic index stale and stops there. It does
  not reindex. Search serves keyword results until the user runs an explicit
  reindex.
- D6: Setup, `doctor`, and `init` each show how to install Ollama and which
  models are recommended. A dedicated document is the single source for that
  guidance, and the three surfaces reference it rather than restating it, so the
  advice cannot drift between them. Removing `knowns model` (D4) removes the
  place users previously discovered models, and this replaces it.
- D7: Detection may narrow the configuration, never widen it. `init` and `setup`
  turn semantic search off when no Ollama can be reached, because the
  alternative is a project that declares an embedder it cannot use. They never
  turn it on merely because Ollama is present: `.knowns/config.json` is
  git-tracked, so deciding from machine state writes one developer's laptop into
  everyone's repository. An interactive run may preselect and explain; it may
  not decide. This generalises the capability gate that already exists for the
  platform where local ONNX cannot run, rather than removing it with the ONNX
  path.
- D8: `init` never pulls a model. A pull is hundreds of megabytes, and D5
  already settled that expensive work does not happen implicitly. When the
  machine already has an embedding model, `init` offers that one ahead of the D2
  default, because it is already on disk and costs nothing. A non-interactive
  run neither probes nor pulls.
- D9: Migration always writes the D2 default model, whatever the machine has
  installed or configured. Migration rewrites a file the rest of the team will
  pull, so its output must depend only on the file it reads. This deliberately
  differs from D8: `init` creates a configuration nobody depends on yet, while
  migration edits one that others already use. The two rules are the same
  principle applied to different blast radii, not an inconsistency.
- D10: `knowns migrate` is a versioned migration runner, not a one-off for this
  change. The project config carries a schema version; the command applies every
  registered migration above that version, in order, and stamps the result. This
  is the shape the ecosystem has converged on for configuration that lives in
  version control — `ng update` gates on a version delta, `nx migrate` separates
  planning from applying, `biome migrate` previews unless told to write — and it
  is the shape this repository already uses for skills in
  `internal/sync/autosync.go`, which compares a stored `cliVersion` before
  acting. The difference here is only that the target is committed, so the
  apply step is a command rather than a side effect. Preview is the default and
  `--write` applies. There is no rollback subcommand: the file is in git, and
  git is the rollback. Every migration must be idempotent.
- D11: The command lives at the top level as `knowns migrate`, not under a noun
  like `knowns config migrate`, because the registry of D10 will outgrow config:
  a later migration may touch lifecycle settings, permissions, or stored state,
  and `doctor` needs one name to point at. It does not absorb
  `knowns decision migrate`, and the shared word is a surface coincidence. They
  are different operations: `knowns migrate` upgrades a project's schema to the
  current version and is version-gated, idempotent, and safe to re-run, while
  `knowns decision migrate` converts legacy Memory entries into Decision
  entities one at a time under human review. An upgrade is not a conversion, and
  merging them would put an irreversible data transform behind a command users
  are told to run after every release.

## System Decision Impact

- Impact: draft new
- Decision: to be created on approval, following the shape of
  `20260819-1703-remove-the-opencode-chat-ui`: a subsystem is removed, the user
  installs the replacement themselves, and the breaking config changes are
  enumerated.
- Acceptance gate: the decision stays draft until the removal is merged and a
  commit can be cited as evidence.

### Superseded in full

- @doc/features/model-command. Every section describes the removed command tree,
  the `~/.knowns/models/` layout, `custom-models.json`, or the Local ONNX picker
  in `knowns settings`. Nothing in it survives D4.

### Superseded in part

- @doc/specs/semantic-search. Void: FR-3 auto-download, NFR-1 "model download
  < 100MB", NFR-3 offline-after-download, the `modelPath` config field, and the
  recommended model table. Retained: chunking strategy, index version control,
  hybrid mode, MCP tool changes, FR-4 through FR-8.
- @doc/specs/openai-compatible-embedding-provider. Void: NFR-1 "existing local
  ONNX path remains default and unchanged", FR-12 automatic reindex on dimension
  change, FR-9 API-backed models via `knowns model add`. Retained: the provider
  and model registry, reachability checks, retry and batching, NFR-2 through
  NFR-6.
- @doc/specs/multi-store-semantic-memory-retrieval. Void: FR-6 and FR-7 model
  download during init and sync, FR-8 `multilingual-e5-small` as the default
  model. Retained: everything about multi-store retrieval and merging.
- @doc/specs/semantic-search-quality-improvements. Void: FR-3 and AC-5
  tokenizer-based token counting, and Scenario 3, because the tokenizer is
  removed with the ONNX path. Void in part: AC-1, for the local models that no
  longer exist. Retained: the query/document prefix mechanism, which now applies
  to the HTTP provider, and the chunking requirements.

### Rewritten, not superseded

- @doc/guides/semantic-search-guide is a guide, not a spec. It is written around
  local ONNX model selection and management and must be rewritten for Ollama.
  It is not, however, the FR-9 guidance surface: it lives in this repository's
  own `.knowns/docs/`, and `init` seeds no documents into a user's project, so
  nothing there is ever delivered to the users FR-10 and FR-11 are written for.
  The published documentation is that surface, and both this guide and the
  published pages read the single source FR-9 defines.

### Deliberate overrides of approved requirements

- D5 overrides @doc/specs/openai-compatible-embedding-provider FR-12, which
  requires an automatic reindex when the model's dimensions change. The migration
  is exactly such a change. D5 marks the index stale instead, because reindexing
  during a config load would block the first command for minutes and would fail
  outright when Ollama is not yet installed, which is the common state at that
  moment.
- FR-6 is not new scope. Three approved specs already require it and the code
  violates all three: @doc/specs/semantic-search NFR-4,
  @doc/specs/multi-store-semantic-memory-retrieval FR-12, and
  @doc/specs/openai-compatible-embedding-provider NFR-6. Removing the ONNX path
  turns a rare failure into an ordinary one, which is why the debt has to be paid
  here rather than later.
- Removing the tokenizer downgrades token counting from exact to estimated for
  every provider, against @doc/specs/semantic-search-quality-improvements FR-3.
  The estimator was improved separately to reduce the cost of this, but it
  remains a downgrade and must be recorded as one.
- D7 changes the default that `init` has carried until now, which is to enable
  semantic search in any interactive run. That default was safe only because the
  embedder shipped inside the binary. Once the embedder is a service the user
  installs separately, the same default produces a project that declares an
  embedder it cannot reach, and the configuration file recording that claim is
  committed to the repository.
- D8 and D9 disagree about whether the machine's existing model matters, and
  that is intended. FR-14 lets `init` prefer a model already on disk; FR-3
  forbids migration from doing the same. The difference is who depends on the
  result: `init` writes a configuration nobody has pulled yet, while migration
  rewrites one that the rest of the team already has. An implementer who reads
  only one of the two will see a contradiction, so both name the other.

## Requirements

### Functional Requirements

- FR-1: The local ONNX embedding path is removed: the runtime loader, the native
  embedder, the ONNX capability probe, the tokenizer implementation, the model
  download and setup flow, the `knowns model` command tree, the web route
  serving the embedding model catalogue, and the built-in embedding model table
  in `internal/search/types.go`. Where a removed piece gated configuration
  rather than merely implementing it, it is replaced rather than deleted: the
  capability check that disables semantic search where local ONNX cannot run
  becomes the Ollama reachability gate of FR-13.
- FR-2: The `github.com/yalue/onnxruntime_go` dependency is removed from the
  module, and the release pipeline no longer downloads or packages an ONNX
  runtime library for any platform.
- FR-3: A project whose semantic settings declare `provider: local` resolves as
  though it declared `provider: ollama` with the default model from D2. This
  resolution happens in memory on every read and changes nothing on disk. The
  model resolved is always the D2 default, independent of what the machine has
  installed, pulled, or configured (D9).
- FR-4: A project still carrying an unmigrated config reports it once per
  command in a single line naming `knowns migrate`, rather than repeating the
  full remediation. The full account — install Ollama, pull the model, reindex —
  belongs to the migration command's own output and to `doctor`, where the user
  has asked for it.
- FR-5: The global model registry is seeded with the three models from D2,
  including the dimensions, context limit, and any query or document prefix each
  requires. Seeding also registers the `ollama` provider entry the seeded models
  reference, because resolution reads the model and then its provider, and a
  model whose provider is absent fails exactly as a missing model does. Seeding
  must not overwrite an entry the user already defined. No `api` provider is
  seeded: Ollama has a correct default endpoint that needs no input, while a
  third-party endpoint needs a URL and usually a key, and a placeholder entry
  would resolve and then fail at request time, which is worse than absent.
- FR-6: When semantic retrieval fails because the embedder cannot be reached or
  returns an error, the search returns keyword results instead of an error. This
  holds for every mode: in hybrid the keyword results already exist and are
  currently discarded, while in semantic mode they must be computed on the
  failure path, because that mode never runs a keyword pass today.
- FR-7: After migration the existing semantic index is reported stale, because
  the embedding identity changed. Search does not use it and `doctor` names the
  reindex command.
- FR-8: `doctor` no longer reports ONNX runtime state. A project whose
  configured Ollama model is absent from the machine is reported with the
  `ollama pull` command needed to obtain it.
- FR-9: One data source in code is the single origin of Ollama guidance: the
  recommended models from D2 with the tradeoffs that separate them, the install
  location, and the pull command. Every surface that advises the user reads that
  source, including the written documentation, so a model added to or removed
  from D2 changes every surface at once. The prose home for that guidance is the
  published documentation, in every language the project ships, because a
  document that lives only in this repository's own `.knowns/docs/` is never
  delivered to a user's project — `init` seeds no documents. That guidance also
  shows the shape of a third-party OpenAI-compatible provider entry, since FR-5
  deliberately seeds none.
- FR-10: Setup, `doctor`, and `init` distinguish four states and act differently
  in each: Ollama not installed, installed but not running, running but without
  the required model, and ready. The first three each name the specific next
  step for that state rather than a single generic message, and each states that
  keyword search continues to work regardless.
- FR-11: The guidance shown by FR-10 names the default model and the command to
  obtain it, so a user who reads nothing else can still reach a working state.
- FR-12: Chunk sizing resolves the model's context limit through the embedder's
  own model configuration rather than a package-level table. Removing the table
  of FR-1 must not leave call sites silently falling back to a conservative
  constant, which would truncate long-context models without any error.
- FR-13: `init` and `setup` do not enable semantic search when no reachable
  Ollama is detected. They report that semantic search requires Ollama or an
  OpenAI-compatible provider, that keyword search is unaffected, and how to
  proceed. When Ollama is reachable they may preselect the enabled state in an
  interactive run, but the written configuration follows the user's answer, not
  the probe (D7).
- FR-14: `init` does not download an embedding model. When the machine already
  serves one, that model is offered first; otherwise the D2 default is offered
  together with its pull command (D8).
- FR-15: The web UI no longer offers a local ONNX embedding source or model
  picker.
- FR-16: Writing the global embedding settings preserves the fields the settings
  file already carries. Seeding and migration write that file on paths the user
  did not initiate, so a load-and-save round trip must not silently drop
  configuration the user wrote by hand.
- FR-17: The platform special-casing that exists only because local ONNX is
  unavailable on some platforms is removed along with it, in the release
  pipeline as well as in `doctor`, `config`, and `init`.
- FR-18: The project config carries a schema version, and `knowns migrate`
  applies every registered migration above it in order before stamping the new
  value. The version lives in the committed config rather than in per-machine
  state, so that a migration applied by one developer and committed is recorded
  for everyone who pulls it. Migrating this release's `provider: local` config
  is the first registered migration, not a special case in the command.
- FR-19: `knowns migrate` reports what it would change and writes nothing unless
  asked. This matches the preview-by-default rule the lifecycle actions already
  follow. Applying prints the resulting change and tells the user to review and
  commit it. There is no rollback: the file is in version control.
- FR-20: Every migration is idempotent, and running `knowns migrate` with
  nothing pending reports that and exits without writing.
- FR-21: `doctor` reports an unmigrated project and names `knowns migrate` as
  the remediation, so the command is discoverable without reading release notes.

### Non-Functional Requirements

- NFR-1: No search request may fail because an embedding provider is
  unavailable. Availability of the provider affects result quality, never
  whether results are returned.
- NFR-2: Migration must not delete or rewrite indexed vectors. It changes
  configuration and marks state stale; destroying data is the reindex's job.
- NFR-3: Seeding the registry must be idempotent across repeated runs.
- NFR-4: A non-interactive `init` produces the same project configuration on
  every machine, whether or not Ollama is installed. The file it writes is
  committed, so a command that reads machine state to decide its contents makes
  the repository depend on whoever ran it.
- NFR-5: Any Ollama probe added to `doctor` completes well inside the per-check
  time budget, including when the endpoint accepts the connection and then never
  answers. A check that reports a timeout instead of its subject has already
  been shipped once and is worse than no check.
- NFR-6: Failure classification must be explicit rather than inferred from error
  text. FR-6 degrades on operational failure and must still surface a
  programming error, and matching on messages makes that boundary silently
  wrong as the messages change.

## Acceptance Criteria

- [ ] AC-1: `grep -ri onnx` over `internal/`, `cmd/`, and `ui/src` returns no
      functional references, and `go.mod` no longer lists `onnxruntime_go`.
- [ ] AC-2: `.github/workflows/publish.yml` contains no ONNX runtime download or
      packaging step, no platform-conditional bundling, and the published
      archive for every platform contains only the binary. The build matrix
      states whether CGO is still required, and why.
- [ ] AC-3: Loading a project config with `provider: local` yields resolved
      settings with `provider: ollama` and the D2 default model, and the file on
      disk is byte-identical afterwards.
- [ ] AC-4: A command run against an unmigrated project prints one line naming
      `knowns migrate`, and `knowns migrate` itself names all three of
      installing Ollama, pulling the model, and running a reindex.
- [ ] AC-5: On a machine with no `~/.knowns/settings.json`, resolving the
      default model succeeds and returns 1024 dimensions without any network
      call, and resolving that model's provider succeeds too, so an embedder can
      actually be constructed from a fresh install.
- [ ] AC-6: A user-defined registry entry with the same key as a seeded model
      survives seeding unchanged.
- [ ] AC-7: With a vector store holding chunks and an embedder whose endpoint
      refuses connections, `Search` returns keyword results and no error, for
      both hybrid and semantic modes.
- [ ] AC-8: After migrating, semantic readiness reports the index stale,
      `doctor` warns with `knowns search index --wait`, and a search returns
      keyword results.
- [ ] AC-9: `doctor` exposes no check reporting ONNX runtime availability.
- [ ] AC-10: With Ollama running but the configured model not pulled, `doctor`
      reports the model as missing and names `ollama pull <model>`.
- [ ] AC-11: `knowns model` is not a registered command.
- [ ] AC-12: The Ollama guidance exists in the published documentation in every
      language the project ships, names all three seeded models with the
      tradeoff that distinguishes each, gives the install and pull commands, and
      shows the shape of a third-party provider entry.
- [ ] AC-13: On a machine where no Ollama can be reached, a non-interactive
      `init` writes a config with semantic search disabled, and its output
      states that keyword search works, names the default model, the command to
      obtain it, and where to read more.
- [ ] AC-14: With Ollama absent, `doctor` remediation names the guidance and
      states that keyword search continues to work without Ollama.
- [ ] AC-15: The guidance text in setup, `doctor`, `init`, and the published
      documentation resolves from one shared source, so a model added to or
      removed from D2 changes all of them without editing each call site.
- [ ] AC-16: The full test suite passes, and tests cover: the migration
      rewriting config, seeding idempotency, keyword fallback on embedder
      failure, and stale reporting after a dimension change.
- [ ] AC-17: A search whose semantic leg fails for a non-operational reason
      still returns an error rather than silently degrading to keyword results.
- [ ] AC-18: Indexing with a model whose context limit exceeds the former
      default produces chunks sized to that limit, proving chunk sizing no
      longer resolves through the removed table.
- [ ] AC-19: `doctor` distinguishes Ollama not installed, installed but not
      running, and running without the required model, and gives a different
      remediation for each.
- [ ] AC-20: The `doctor` Ollama probe returns within its budget against an
      endpoint that accepts the connection and never responds.
- [ ] AC-21: `init --yes` produces byte-identical `semanticSearch` settings on a
      machine with Ollama and a machine without it.
- [ ] AC-22: `knowns migrate --write` produces the same model on a machine that
      has a different embedding model pulled and set as its own default.
- [ ] AC-23: An interactive `init` on a machine already serving an embedding
      model offers that model, and no `init` path downloads a model.
- [ ] AC-24: A settings file containing a field the current struct does not
      model still contains that field after seeding has written the file.
- [ ] AC-25: The web UI offers no local ONNX embedding source, and building the
      UI produces no reference to one.
- [ ] AC-26: `knowns migrate` with no flags leaves every file unchanged and
      reports the pending migrations; `knowns migrate --write` applies them,
      stamps the new schema version, and reports what changed.
- [ ] AC-27: Running `knowns migrate --write` twice changes nothing the second
      time and reports that nothing is pending.
- [ ] AC-28: A project already at the current schema version runs no migration,
      and a project several versions behind runs every intervening migration in
      order.
- [ ] AC-29: `knowns migrate --write` removes `huggingFaceId` from the config it
      rewrites, and loading a config that still carries the field neither fails
      nor warns.
- [ ] AC-30: `doctor` reports an unmigrated project and names `knowns migrate`.

## Scenarios

### Scenario 1: Existing local-ONNX project is migrated
**Given** a project whose config declares `provider: local` with
`multilingual-e5-small` at 384 dimensions, and an index built from it
**When** any command loads the project
**Then** the settings resolve to `provider: ollama` with the D2 default model,
the file on disk is untouched, one line names `knowns migrate`, the index is
reported stale, and search returns keyword results
**And when** the user runs `knowns migrate --write`
**Then** the config is rewritten, `huggingFaceId` is dropped, the schema version
is stamped, and the output names the install, pull, and reindex steps and asks
the user to review and commit the change

### Scenario 2: Ollama is installed but not running
**Given** a migrated project with an index built against the Ollama model
**When** the user searches while the Ollama service is stopped
**Then** keyword results are returned without an error, and the absence of
semantic results is not reported as a failure

### Scenario 3: Fresh install with no global settings
**Given** a machine with no `~/.knowns/settings.json`
**When** the user runs `knowns init` and enables semantic search
**Then** the three seeded models are offered, the default resolves to 1024
dimensions and a usable provider without a network call, and the output states
that Ollama or a third-party provider is required for semantic search while
keyword search is not

### Scenario 4: User already customised the registry
**Given** a user-defined `embeddingModels` entry keyed `all-minilm` pointing at a
different provider
**When** seeding runs
**Then** that entry is left exactly as the user wrote it, and any field the
settings file carries that the current struct does not model is still there

### Scenario 5: Model configured but never pulled
**Given** a migrated project and a running Ollama that has not pulled the model
**When** the user runs `doctor`
**Then** the model is reported missing with `ollama pull <model>` as the
remediation, and search still returns keyword results

### Scenario 6: Init on a machine with no Ollama
**Given** a machine where no Ollama can be reached
**When** the user runs `knowns init`
**Then** the project is created with semantic search disabled, the output states
that keyword search works and what installing Ollama would add, and an
interactive run may offer to enable it but does not preselect it

### Scenario 7: Two developers, two machines
**Given** one machine serving `qwen3-embedding:0.6b` and another serving
`nomic-embed-text`, both cloning the same repository
**When** each runs a non-interactive `init`, or loads a project that migrates
**Then** both write the same `semanticSearch` settings, because the committed
file records what the project declares and never what the machine happens to
have; the models each machine actually serves affect only their own local index

## Technical Notes

The keyword fallback in FR-6 is two different changes wearing one name. In
hybrid mode it is a boundary fix, not a new code path: `hybridSearch` already
returns `kwResults` alongside the error at `internal/search/engine.go:1289`, and
`Search` discards both at `engine.go:131-133`. The memory variant at
`engine.go:1338` already does the right thing and is the precedent to follow. In
semantic mode there is nothing to rescue — `Search` dispatches straight to
`semanticSearch` at `engine.go:125`, which returns `nil, err` without ever
running a keyword pass, so satisfying AC-7 there means adding one. An earlier
draft of this spec claimed the whole of FR-6 was a boundary fix; that was true
of hybrid only.

The failure classification FR-6 needs has exactly three sources, all at the
embedder boundary: the `EmbedQuery` call, the vector store's `LastSearchError`,
and the nil-embedder branch that reports semantic search as unavailable. Marking
those three and letting everything else propagate satisfies NFR-6 without
inspecting error text.

Semantic readiness already compares the recorded embedding identity against the
configured one at `internal/search/semantic_readiness.go:278` and `:366`, and
the dimensions at `internal/search/qdrant_reconcile.go:610-614`, so FR-7 needs
no new staleness mechanism. Migration changes the model name as well as the
dimensions, so the existing model comparison detects it before the dimension
check is reached.

FR-12 is nearly built already. `EmbedderProvider` carries `ModelConfig()`
(`internal/search/types.go:84`), and the API embedder's implementation returns
the context limit from configuration rather than a constant, with a comment
noting that pinning it silently truncated long-context models.

The table being removed, `EmbeddingModels` at `internal/search/types.go:116`, has
sixteen references across ten files. They fall into three groups, and only the
first is FR-12's:

- Chunk sizing, which must be re-pointed at `embedder.ModelConfig()`:
  `internal/search/index.go:469,478,487,496` and
  `internal/search/qdrant_reconcile.go:952,961`. Missing these leaves no compile
  error — the lookups simply miss and every model chunks at the fallback
  constant.
- References that die with the ONNX path itself and need no separate decision:
  `internal/search/embedding_native.go:26`, `internal/search/init.go:112`,
  `internal/search/semantic_runtime.go:497` (the local-provider branch),
  `internal/cli/init.go:637,729`, `internal/doctor/search_checks.go:358`,
  `internal/server/routes/embedding_models.go:164,165`, and
  `internal/search/search_test.go:83`.
- One that belongs to neither and is easy to miss:
  `internal/services/status.go:529` resolves the model config for status
  reporting on every provider, not just the local one, so it needs the same
  treatment as the chunk-sizing group rather than deletion.

FR-5's provider seeding has a working precedent at
`internal/cli/config.go:1074-1083`, which already registers the `ollama` provider
when it is absent. Today that runs only inside the interactive configuration
flow; seeding needs the same block on a path the user did not initiate.

FR-13 replaces rather than invents. `applyLocalONNXInitCapability` in
`internal/cli/init.go:302-308` already implements the exact shape D7 describes
for the platform where local ONNX cannot run: it clears the enabled flag and
prints a warning naming the next command. `doctor` mirrors it at
`internal/doctor/search_checks.go:76-90` through the existing
`Remediation{Description, Command}` structure. Detection is available and cheap:
`internal/search/ollama_detect.go` exposes `IsRunning`, `ListEmbeddingModels`,
and `GetEmbeddingDimensions`, and the interactive configuration flow already
calls them.

NFR-5 is not hypothetical. The `search.model` check previously reported
`checker_timeout` because it reached a detector far more expensive than the
per-check budget allowed, and reported that timeout instead of its subject.

Removing the ONNX path makes the tokenizer implementation unreachable, because
its only caller is the ONNX runtime constructor. The chunker's token counting
already falls back to estimation whenever no tokenizer is supplied, which is
every HTTP-backed provider, so removal changes no behaviour there.

The index is not shared. `.knowns/.gitignore` tracks only `config.json`, `docs/`,
`templates/`, and `decisions/`, so vectors, watermarks, and history state are
per-machine. Two machines running different models therefore corrupt nothing —
they simply retrieve differently, which is why D9 constrains only the committed
file and leaves the local index alone. `defaultEmbeddingModel` already exists in
the global settings struct with no code that reads it to select a model; making
it the per-machine override is the natural follow-up and is deliberately out of
scope here.

Enumerate the reference sets with `code.references` rather than a text search.
The sixteen references above were established that way after a grep over the
same symbol returned ten, having silently dropped test files and truncated its
own output. Note that `code.find` resolves symbol declarations per package and
does not recurse: given a path of `internal`, the repository root, or no path at
all it returns a partial set without saying so, while `internal/search` returns
the correct one.

`knowns-hub` in this workspace is a live instance of Scenario 1 and is the
natural first verification target.

## Task Generation

- Task Prefix: OLM

Tasks generated from this spec carry the `OLM-` prefix so the removal wave is
identifiable on the board without changing `settings.defaultTaskIdPrefix`, which
stays unset and continues to produce legacy six-character IDs for everything
else. `kn-plan` passes this value as `prefix` on each `tasks.create`, which is a
per-call override and does not touch the committed config — the same rule D1 and
D7 apply to every other machine-side decision in this spec.

Note for implementers: the ID is used verbatim. In the file name
`task-OLM-398962 - ...md` the leading `task-` belongs to the file name and the
`OLM-` belongs to the ID; neither hyphen is separable from what follows it.

The project runs the `read-write-no-delete` permission preset, so tasks from this
wave can be archived but not deleted, and archival requires the task to be `done`
first.

## Task Links

Generated tasks will be linked here after `/kn-plan --from @doc/specs/2026-08-24/ollama-only-embedding` runs.

## Open Questions

None. Every question raised during review is recorded below with its
resolution.

Resolved during spec review:

- Supersession scope. Answered by reading the candidate specs; the result is
  recorded under System Decision Impact rather than left open.
- Where the FR-9 guidance lives. Split in two: the single source is a data
  table in code, and its prose home is the published documentation rather than
  a document inside this repository's own `.knowns/docs/`.
- Whether `init` enables semantic search from machine state. It does not; see
  D7. Detection narrows the configuration and never widens it, because the file
  it writes is committed.
- Whether migration follows the machine's preferred model. It does not; see D9.
  The rule differs from D8 on purpose, because `init` creates a configuration
  nobody depends on yet while migration edits one that others already use.
- Whether one model must be shared across machines. Only the declared model is
  shared, because only `config.json` is committed; the index itself is
  per-machine and never exchanged. Making `defaultEmbeddingModel` a per-machine
  override is a separate scope.
- Whether `huggingFaceId` stays accepted or becomes a validation error. Neither.
  Reading a config that still carries it neither fails nor warns, and the field
  is dropped by the rewrite in D10's migration, which is a deliberate user
  action rather than a side effect of loading.
- Whether the `api` provider is seeded. It is not; see FR-5. Ollama has a
  correct default endpoint and needs no input, while a third-party endpoint
  needs a URL and usually a key, so a placeholder would resolve and then fail at
  request time. FR-9 documents the shape instead.
- Whether migration should be automatic. Resolution is; persistence is not; see
  D1 and D10. The repository already splits these the same way — history
  migrations run silently against git-ignored state, `knowns decision migrate`
  is explicit because decisions are tracked — and the wider ecosystem has
  converged on the same rule for configuration under version control.
- Task Prefix. Set to `OLM` at spec level rather than enabling a project-wide
  default, which would prefix every future task for a decision this wave does
  not need to make. Verified end to end: a probe task created over MCP with that
  prefix produced `OLM-398962`, resolved by that ID from both MCP and the CLI,
  and left `settings.defaultTaskIdPrefix` and the committed config untouched.
- Command surface for the runner. Top level, `knowns migrate`; see D11. It does
  not absorb `knowns decision migrate`, which is a reviewed data conversion
  rather than a schema upgrade.
