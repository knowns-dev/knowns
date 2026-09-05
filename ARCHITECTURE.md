# Architecture

Knowns is a single Go binary. It keeps a project's durable knowledge (tasks,
docs, decisions, memory, templates) as markdown on disk, and exposes that same
store to humans through a CLI and a web UI, and to AI agents through an MCP
server.

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
`internal/references` and `internal/storage/reference_resolution.go`, so a
decision can cite the task that produced it and a task can cite the doc that
constrains it. Resolution is what makes the store a graph rather than a folder.

## Repository layout

```
cmd/knowns/main.go        Entry point; calls internal/cli.Execute
internal/                 All application code (30 packages, 34 with subpackages)
ui/                       React 19 + Vite web UI, embedded into the binary
tools/gendocs/            Generates and verifies the CLI reference
docs/                     Hand-written docs (en, vi) plus the generated reference
tests/                    CLI and MCP end-to-end tests
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

## Package map

Sized by non-test lines, because where the code actually is tends to differ
from where people assume it is.

| Package | Lines | Responsibility |
|---|---:|---|
| `cli` | 20.3k | Cobra command tree, TUI rendering, all 33 top-level commands |
| `storage` | 15.6k | Entity stores, mutation transactions, locks, history, reconciliation |
| `search` | 14.3k | Chunking, embeddings, BM25 lexical backend, SQLite and Qdrant vector stores |
| `lsp` | 8.9k | Language server adapters, detection, install, file sync |
| `server` | 8.3k | HTTP API (chi), SSE broker, WebSocket, embedded UI |
| `mcp` | 7.2k | MCP server and its 12 tool handlers |
| `doctor` | 3.0k | Read-only diagnostics and remediation model |
| `models` | 2.7k | Entity types: task, doc, decision, memory, template, config |
| `tasklifecycle` | 2.4k | Task status policy and permitted transitions |
| `runtimequeue` | 2.2k | Background job queue for indexing and reconciliation |
| `lspdaemon` | 1.7k | Project-scoped LSP daemon and leases |
| `runtimememory` | 1.4k | Builds the memory payload that agent hooks inject |
| `codegen` | 1.2k | Handlebars-compatible template engine |
| `decisionmigration` | 1.1k | Reversible bridge from legacy decision memories |
| `decisionreview` | 1.1k | Detects decisions that overlap or contradict existing ones |
| `qdrantruntime` | 1.0k | Installs and supervises a managed Qdrant process |
| `runtimeinstall` | 1.0k | Writes agent hooks for Claude Code, Codex, Kiro, OpenCode |
| `validate` | 0.9k | Shared validation for tasks, docs, templates, spec compliance |
| `memoryreview` | 0.6k | Memory promotion, demotion, staleness review |

Smaller packages: `services`, `util`, `permissions`, `readiness`,
`references`, `tunnel`, `registry`, `safepath`, `instructions`, `process`,
`gitauth`.

## Entry points

All three read and write the same markdown store through `internal/storage`.
None of them owns state the others cannot see.

### CLI

```
cmd/knowns/main.go
  -> cli.Execute
     -> cobra dispatch
        -> internal/storage (read/write markdown)
        -> internal/runtimequeue (enqueue reindex)
```

### MCP server

`knowns mcp` starts an MCP server over stdio using `mark3labs/mcp-go`. It
exposes 12 tools, each an action dispatcher rather than one tool per verb:

`initial`, `help`, `tasks`, `docs`, `search`, `code`, `decision`, `memory`,
`templates`, `time`, `validate`, `project`.

`search` carries the retrieval actions (`search`, `retrieve`, `resolve`); there
is no separate `retrieve` tool.

### Web UI

`knowns browser` starts the HTTP server and opens the UI. The compiled React
app is embedded via `ui/embed.go` (`//go:embed dist/*`) and served from the
binary, so a release needs no separate asset deployment.

```
internal/server/server.go   chi router, static UI, WebSocket upgrade
internal/server/routes/     REST endpoints per entity kind
                            broker.go carries SSE fan-out
```

Mutations made through the CLI reach an open browser tab because the server
watches the store with `fsnotify` and pushes changes over SSE and WebSocket.

## Search

Two independent paths, so the tool stays useful without a model:

- **Lexical.** BM25 over chunked content (`search/code_bm25.go`,
  `search/lexical_backend.go`). No embeddings, no network, always available.
- **Semantic.** Chunk, embed, then nearest-neighbour search. Embeddings come
  from Ollama or a configured provider API (`search/embedding_api.go`,
  `search/ollama_detect.go`).

Vectors live in one of two backends behind the same interface:

- `search/sqlite_vecstore.go` writes `.knowns/.search/index.db`, holding
  `chunks`, `metadata`, `content_hashes`, and `code_file_hashes`. This is the
  default and needs nothing installed.
- `search/qdrant_vecstore.go` talks to a Qdrant instance that
  `internal/qdrantruntime` can install and supervise. Chosen for larger stores.

Indexing does not happen inline. `internal/runtimequeue` accepts jobs
(`index-task`, `index-doc`, `index-decision`, `index-memory`, `index-file`,
`index-all-files`, `reconcile-knowledge`, `reconcile-qdrant`) and drains them
in a background runtime, so writing a task never blocks on an embedding call.

## Background runtimes

Three long-lived processes, all optional, all started on demand and addressed
by hidden commands the binary invokes on itself:

| Process | Started by | Purpose |
|---|---|---|
| Runtime worker | `knowns __runtime run` | Drains the indexing and reconciliation queue |
| LSP daemon | `knowns __lsp-daemon run --project <root>` | Shares language servers across sessions via leases |
| Qdrant | `internal/qdrantruntime` | Managed vector backend when configured |

Those `__`-prefixed commands are hidden but locked: they appear in
`internal/cli/testdata/command-contract.txt`, so renaming one is a reviewed
diff rather than a runtime surprise. See "Extension points".

## Agent integration

`internal/runtimeinstall` writes hook artifacts into a user's home directory
for Claude Code, Codex, Kiro, and OpenCode. Each hook invokes
`knowns runtime-memory hook --runtime <name> --event <event>`, and
`internal/runtimememory` answers with the memory payload the agent injects into
its context.

Those artifacts are written by one version of the binary and executed by a
later one, so that argv is a compatibility contract, not an implementation
detail. `TestInstalledHookArgvResolves` installs every adapter into a temporary
home and resolves the argv it finds back against the live command tree.

`internal/instructions` embeds the skills (`kn-*`) and unified guidelines that
`knowns sync` writes into a project. They ship inside the binary, which is why
editing a skill in the source tree has no effect until you rebuild.

## Technology stack

| Layer | Choice |
|---|---|
| Language | Go 1.25 |
| CLI | `spf13/cobra` |
| TUI | `charm.land/bubbletea/v2`, `bubbles/v2`, `lipgloss/v2`, `glamour/v2` |
| HTTP | `go-chi/chi/v5`, `rs/cors` |
| MCP | `mark3labs/mcp-go` |
| Storage | Markdown plus `gopkg.in/yaml.v3` frontmatter |
| Derived index | `modernc.org/sqlite` (pure Go, no cgo) |
| File watching | `fsnotify/fsnotify` |
| Web UI | React 19, Vite 7, TypeScript 5.7, Tailwind 4, Radix UI, dnd-kit |

The build sets `CGO_ENABLED=1` for the race detector, not because anything in
the module binds to C. The SQLite driver is pure Go, which is what keeps the
single-binary distribution possible.

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
Hiding them keeps the help output honest; the contract snapshot keeps hiding
them from turning into forgetting them.

## Extension points

### Adding a command

Add the command in `internal/cli`, register it on `rootCmd`, then:

```bash
make cli-docs        # regenerate docs/en/cli-reference and the contract snapshot
make cli-docs-check  # verify both, plus that hand-written docs still typecheck
```

Do not hand-edit `docs/en/cli-reference/` or
`internal/cli/testdata/command-contract.txt`.

### Retiring a command

Add an entry to `commandLifecycle` in `internal/cli/lifecycle.go` rather than
deleting the command. A deprecated command keeps working and is hidden; a
removed one leaves a tombstone that names its replacement instead of failing
with "unknown command". Anything a machine invokes must keep `Announce: false`,
because cobra writes its deprecation notice into output that adapters parse.

### Adding an MCP tool

Add a handler under `internal/mcp/handlers/` and register it in the server.
Prefer a new action on an existing tool over a new tool.

### Adding an API endpoint

Add the route file under `internal/server/routes/` and mount it in
`router.go`.

## Security

- `internal/safepath` resolves untrusted paths inside an explicit root, so a
  crafted doc path cannot escape `.knowns/`.
- `internal/permissions` holds the shared action registry and policy model used
  to gate mutating operations.
- `internal/gitauth` applies Git HTTP credentials only to a host that has been
  explicitly trusted.
- The HTTP server binds to localhost by default. `knowns tunnel` can expose it
  through a Cloudflare Quick Tunnel, which is opt-in and per-invocation.

## Performance notes

- Reads go straight to the filesystem; there is no daemon in the path of a CLI
  read.
- Writes take a per-entity lock (`.knowns/history/locks/`) so concurrent agents
  do not interleave edits to the same file.
- Content hashes in the index let reindexing skip unchanged chunks, so a
  reindex after a small edit is proportional to the edit, not the store.
- Language servers are shared through the LSP daemon's leases rather than
  started per invocation.
