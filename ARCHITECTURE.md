# Architecture

Knowns is a single self-contained binary, written in TypeScript and compiled
with Bun. It keeps a project's durable knowledge (tasks, docs, decisions,
memory, templates) as markdown on disk, and exposes that same store to humans
through a CLI and a web UI, and to AI agents through an MCP server.

Releases up to 0.34.1 were written in Go. The Go code was removed from the
repository after 0.35.0; this file describes the TypeScript code under `cli/`.

Everything below describes the code as it is. If a statement here disagrees
with the tree, the tree wins and this file is the bug. `make cli-docs-check`
enforces that for the command surface.

## Core principles

### Files are the source of truth

There is no database of record. A task is a markdown file with YAML
frontmatter; so is a doc, a decision, and a memory entry. You can read the
whole store with `cat`, diff it in a pull request, and recover it from git.

What is *not* the source of truth is anything under `.knowns/.search/`. That
directory holds a derived index and is safe to delete: `knowns search index`
rebuilds it. The distinction matters because the index is a SQLite file, and
"no database" is only true of the record, not of the cache.

### Markdown plus frontmatter

```markdown
---
id: KN-4F7Q2M
title: Add JWT authentication
status: in-progress
priority: high
---

## Description

We need JWT auth because sessions do not scale across services.
```

Frontmatter carries the structured fields the CLI and UI query. The body stays
prose, so it is useful to a human reading the file directly and to a model
reading it as context.

### References resolve across entity kinds

`@task-<id>` and `@doc/<path>` inside any body are resolved by
`cli/src/domain/references`, so a decision can cite the task that produced it
and a task can cite the doc that constrains it. Resolution is what makes the
store a graph rather than a folder.

## Repository layout

```
cli/                      The Knowns CLI, MCP server and web server (TypeScript on Bun)
  src/main.ts             Entry point
  src/cli/                Command framework (core/) and one file per command (commands/)
  src/models/             Entity schemas (zod) and pure helpers
  src/storage/            Stores, locks, history, safe paths, project location
  src/domain/             Library code shared by the CLI, MCP and server layers
  src/search/             Chunking, embeddings, lexical and vector search
  src/runtime/            Background queue, executor and Qdrant management
  src/lsp/, src/lspdaemon/  Language server adapters and the shared daemon
  src/mcp/                MCP server, tool definitions and handlers
  src/server/             HTTP API, SSE and WebSocket
  instructions/           Skills (kn-*) and guidelines that `knowns sync` writes
  scripts/                Build, code generation and CLI reference generation
  test/                   Unit tests, differential tests and e2e (test/e2e)
ui/                       React 19 + Vite web UI, embedded into the binary
docs/                     Hand-written docs (en, vi) plus the generated reference
```

A project's store lives in `.knowns/` next to the code it describes:

```
.knowns/
  tasks/          task-<id> - <slug>.md
  docs/           <path>.md
  decisions/      <timestamp>-<slug>.md
  memory/         memory entries by layer
  templates/      code generation templates
  history/        JSONL change history, plus locks and watermark state
  imports/        imported Knowns packages
  archive/        archived entities
  versions/       entity version snapshots
  config.json     project configuration
  .search/        derived index (SQLite); rebuildable, safe to delete
```

## Module map

Under `cli/src/`:

| Module | Responsibility |
|---|---|
| `cli/` | Command framework (`core/`) and the command tree (`commands/`) |
| `storage/` | Entity stores, mutation transactions, locks, history, safe paths |
| `search/` | Chunking, embeddings, lexical backend, SQLite and Qdrant vector stores |
| `lsp/` | Language server adapters, detection, install, file sync |
| `lspdaemon/` | Project-scoped LSP daemon and leases |
| `server/` | HTTP API, SSE and WebSocket, embedded UI |
| `mcp/` | MCP server and its 12 tool handlers |
| `models/` | Entity types: task, doc, decision, memory, template, config |
| `runtime/` | Background job queue, executor and Qdrant installation and supervision |
| `domain/doctor` | Read-only diagnostics and remediation model |
| `domain/tasklifecycle` | Task status policy and permitted transitions |
| `domain/runtimememory` | Builds the memory payload that agent hooks inject |
| `domain/codegen` | Template engine |
| `domain/decisionmigration` | Reversible bridge from legacy decision memories |
| `domain/decisionreview` | Detects decisions that overlap or contradict existing ones |
| `domain/memoryreview` | Memory promotion, demotion, staleness review |
| `domain/validate` | Shared validation for tasks, docs, templates, spec compliance |
| `domain/references` | Reference extraction and resolution |
| `domain/instructions` | Skills and guidelines embedded into the binary |

Libraries under `domain/` never import `src/cli`, so the CLI, MCP and server
layers call the same code.

## Entry points

All three read and write the same markdown store through `cli/src/storage`.
None of them owns state the others cannot see.

### CLI

```
cli/src/main.ts
  -> command framework (cli/src/cli/core)
     -> command in cli/src/cli/commands
        -> cli/src/storage (read/write markdown)
        -> cli/src/runtime (enqueue reindex)
```

### MCP server

`knowns mcp` starts an MCP server over stdio. It exposes 12 tools, each an
action dispatcher rather than one tool per verb:

`initial`, `help`, `tasks`, `docs`, `search`, `code`, `decision`, `memory`,
`templates`, `time`, `validate`, `project`.

`search` carries the retrieval actions (`search`, `retrieve`, `resolve`); there
is no separate `retrieve` tool.

### Web UI

`knowns browser` starts the HTTP server and opens the UI. The compiled React
app is embedded into the binary through a generated
`cli/src/ui-assets.generated.ts` and served from it, so a release needs no
separate asset deployment.

```
cli/src/server/index.ts     HTTP server, static UI, WebSocket upgrade
cli/src/server/routes/      REST endpoints per entity kind
cli/src/server/sse.ts       SSE fan-out
```

Changes made through the CLI reach an open browser tab over SSE and WebSocket.

## Search

Two independent paths, so the tool stays useful without a model:

- **Lexical.** BM25-style keyword search over chunked content
  (`search/lexical.ts`). No embeddings, no network, always available.
- **Semantic.** Chunk, embed, then nearest-neighbour search. Embeddings come
  from Ollama (`search/ollama.ts`, `search/embedder.ts`).

Vectors live in one of two backends behind the same interface:

- `search/sqlite-store.ts` writes `.knowns/.search/index.db`. This is the
  derived index and needs nothing installed.
- `search/qdrant/` talks to a Qdrant instance that `runtime/qdrant-*.ts` can
  install and supervise (`knowns qdrant setup` for Docker or your own). Chosen
  for larger stores.

Indexing does not happen inline. `runtime/queue.ts` accepts jobs and the
runtime executor drains them in the background, so writing a task never blocks
on an embedding call.

## Background runtimes

Three long-lived processes, all optional, all started on demand and addressed
by hidden commands the binary invokes on itself:

| Process | Started by | Purpose |
|---|---|---|
| Runtime worker | `knowns __runtime run` | Drains the indexing and reconciliation queue |
| LSP daemon | `knowns __lsp-daemon run --project <root>` | Shares language servers across sessions via leases |
| Qdrant | `runtime/qdrant-*.ts` | Managed vector backend when configured |

Those `__`-prefixed commands are hidden. See "Extension points".

## Agent integration

`knowns runtime install` writes hook artifacts into a user's home directory
for Claude Code, Codex, Kiro, and OpenCode. Each hook invokes
`knowns runtime-memory hook --runtime <name> --event <event>`, and
`cli/src/domain/runtimememory` answers with the memory payload the agent
injects into its context.

Those artifacts are written by one version of the binary and executed by a
later one, so that argv is a compatibility contract, not an implementation
detail.

The skills (`kn-*`) and unified guidelines that `knowns sync` writes into a
project live in `cli/instructions/skills` and `cli/instructions/guidelines`.
`cli/scripts/gen-instructions.ts` embeds them into
`cli/src/domain/instructions/embedded.generated.ts`, which is why editing a
skill in the source tree has no effect until you regenerate and rebuild.

## Technology stack

| Layer | Choice |
|---|---|
| Language and runtime | TypeScript on Bun 1.3.12+, compiled to one binary per platform |
| CLI | In-repo command framework (`cli/src/cli/core`) |
| Schemas | `zod` |
| Prompts | `@clack/prompts` |
| Storage | Markdown plus YAML frontmatter |
| Derived index | SQLite through `bun:sqlite` |
| Lint and format | Biome |
| Web UI | React 19, Vite, TypeScript, Tailwind, Radix UI, dnd-kit |

`bun run build` in `cli/` produces the binaries; `make build` builds the host
target and `make ts-build` all six.

## Key design decisions

### Why markdown instead of a database

The store is meant to be read by three audiences that do not share a client: a
human in an editor, a diff in code review, and a model given the file as
context. A database serves the first two badly and the third not at all. The
cost is that queries need an index, which is what `.knowns/.search/` is.

### Why SQLite is present anyway

Semantic search needs vectors somewhere. Putting them in markdown would be
absurd, and requiring a server would break the single-binary promise. SQLite is
the smallest thing that works, and it is confined to derived data: delete
`.knowns/.search/` and nothing is lost but time.

### Why indexing is queued rather than inline

Embedding a task takes long enough to be felt on `knowns task create`. The
queue keeps writes at filesystem speed and lets indexing fail, retry, and
dead-letter without taking the write with it.

### Why MCP tools are action dispatchers

Twelve tools with an `action` argument, rather than sixty tools. Agent context
is finite, and a tool list is paid for on every request.

### Why hidden commands exist

`__runtime run` and `__lsp-daemon run` are process entry points, not user
commands, and `runtime-memory hook` is invoked by files on a user's machine.
Hiding them keeps the help output honest.

## Extension points

### Adding a command

Add a command file under `cli/src/cli/commands/` and register it in
`cli/src/cli/commands/index.ts`, then:

```bash
make cli-docs        # regenerate docs/en/cli-reference
make cli-docs-check  # verify it, plus that hand-written docs still typecheck
```

Do not hand-edit `docs/en/cli-reference/`.

### Adding an MCP tool

Add a handler under `cli/src/mcp/handlers/` and its definition in
`cli/src/mcp/defs.ts`. Prefer a new action on an existing tool over a new tool.

### Adding an API endpoint

Add the route file under `cli/src/server/routes/` and mount it from the server.

## Testing

`make test` runs `bun run check` (typecheck and Biome) and the unit tests.
`make test-e2e` runs `cli/test/e2e` against the compiled binary
(`KNOWNS_TS_BIN`). The differential tests compare against Go 0.34.1 built from
the pinned commit `069954a`: `eval "$(make -s go-oracle)"` exports
`KNOWNS_GO_SRC` and `KNOWNS_GO_BIN` (needs a Go toolchain; those tests skip
without it).

## Security

- `cli/src/storage/core/safe-path.ts` resolves untrusted paths inside an
  explicit root, so a crafted doc path cannot escape `.knowns/`.
- The HTTP server binds to localhost by default and accepts requests only from
  its own origin (`KNOWNS_ALLOWED_ORIGINS` allows others). `knowns tunnel` can
  expose it through a Cloudflare Quick Tunnel, which is opt-in and
  per-invocation.

## Performance notes

- Reads go straight to the filesystem; there is no daemon in the path of a CLI
  read.
- Writes take a per-entity lock (`.knowns/history/locks/`) so concurrent agents
  do not interleave edits to the same file.
- Content hashes in the index let reindexing skip unchanged chunks, so a
  reindex after a small edit is proportional to the edit, not the store.
- Language servers are shared through the LSP daemon's leases rather than
  started per invocation.
