# knowns-cli (TypeScript)

Bun + TypeScript rewrite of the Knowns CLI, compiled to one binary per platform.

```
bun install
bun run check     # tsc --noEmit (strict) + biome lint (explicit any is an error)
bun run test      # bun test (build first to also exercise the compiled binary)
bun run build     # cross-compile all targets into dist/<platform>/knowns(.exe)
bun run build bun-linux-x64   # build a subset
bun run budget    # host binary: size delta vs an empty Bun binary <= 30MB, `--version` median <= 150ms
bun run budget dist/linux-x64/knowns dist/windows-x64/knowns.exe   # size delta only (empty baselines cached in dist/.baseline)
```

The UI (`../ui/dist`) is embedded via a generated `src/ui-assets.generated.ts`
(built automatically; the UI is built if `ui/dist` is missing). Use `getUiAsset(path)` from `src/ui.ts`.
`knowns --debug-ui-asset index.html` proves an asset is readable from the binary.
Validate every boundary input with `parseBoundary` from `src/schema/`.

## Storage foundation

- `src/models/` - one zod schema and type per Go model (`internal/models`), plus the pure helpers (ids, config resolution, decision and memory rules).
- `src/storage/core/` - safe paths, project location, store layout and init, manager, store-clone gitignore, JSON/frontmatter utilities, and cross-process locks (`bun:ffi` to libc `flock` / kernel32 `LockFileEx`, same lock files as the Go binary).
- `test/fixtures/` - golden projects written by the Go 0.34.1 binary. `bun run fixtures` regenerates them (builds Go, or set `KNOWNS_GO_BIN`); `bun run fixtures:verify` regenerates into a temp dir and checks the masked digests match the committed manifest.
- `test/helpers/go-helper.go` - drives the real Go locks and safepath for interop tests; tests that need it skip when Go is not installed.
- `src/storage/stores/` - one entity store per Go store (tasks, docs, decisions, memory, templates, time, workspaces, user prefs, audit, config, embedding settings, registry) and the config migrations, with the same on-disk bytes as 0.34.1. `src/models/schema-version.ts` holds the config schema versions so core can stamp new projects without importing stores; `stores/migrations.ts` refuses to load if its registry disagrees.
- `src/storage/history/` - JSONL history with hash chains, the version store, mutation and task lifecycle transactions, and the single implementation of the canonical task, doc and memory hashes (`history/entities.ts`). History reaches the entity stores only through the narrow ports in `history/ports.ts`.

### Wired storage

Layering is `core` <- `history` <- `stores` <- `adapters`. History never imports stores; stores import the canonical task and doc hash from `history/entities.ts`, so a task or doc read through a store always carries a `canonicalHash` equal to the one the history chain records for the same state (there is no registration hook).

`createStorage(store, opts?)` in `src/storage/adapters.ts` builds everything for one project from a `Store`:

```ts
const storage = createStorage(Store.open(root));
// storage.tasks / docs / memory / time / decisions / templates / workspaces / config   (entity stores)
// storage.history (HistoryStore), storage.versions (VersionStore)
// storage.ctx: the HistoryContext (ports over the real stores) for
//   createTaskWithHistory, mutateDocWithHistory, withTaskLifecycleTransaction, ...
```

`adaptTasks`, `adaptDocs`, `adaptMemory` (adds `canonicalHash` and per-id locks) and `adaptTime` (adds `writeEntriesFile`) implement the history ports. `opts.rewriteDocPath` defaults to the reference extractor in `src/domain/references` (inject another only to observe or fail a rename in tests); the lifecycle purge reconciler is injected, not wired (passed to `purgeTaskLifecycle`).

`ConfigStore` keeps Go's `statuses` null versus `[]` distinction (absent and `null` stay `null`). `Manager.switch` registers and activates the project through the stores `Registry` and, like Go, ignores a registry failure.

## Domain libraries

`src/domain/<name>/` holds the ported `internal/<name>` packages that both the CLI and the future MCP/server layers call. They import models, storage and each other, never `src/cli`.

- `domain/references` - the inline reference grammar (`extract`, `parse`, `rewriteDocPath`, `allowedRelation`). `createStorage` wires `rewriteDocPath` as the default doc-rename rewriter. `referenceExtractor` is the adapter for `SearchEnvironment.references` / `Engine` deps (`expandReferences`).
- `domain/validate` - `run(storage, options)` returns `{ issues, errorCount, warningCount, infoCount, valid }` (task, doc, memory, template and spec-decision checks), plus `looksLikeTaskID` and `markdownSectionContent`.
- `domain/codegen` - the template engine (`Engine.run`, `renderString`, `validateTemplate`) over a port of Go's `text/template`, so render output and parse/exec error text match Go's.
- `domain/readiness` - `buildReadiness(storage, env, { runtime?, lsp? })` returns the payload behind `knowns status` (knowledge counts, search readiness, runtime, permissions, capabilities); `inactivePayload()` and `loadRuntimeReadiness(env)` (the read side of the runtime daemon's pid, lease and queue files). The `lsp` section needs the LSP manager (TSR-XSEKND): pass its statuses in `lsp`; without them the section is omitted.

### Search, retrieve, resolve, config, status, quickstart

`commands/search.ts`, `retrieve.ts`, `resolve.ts`, `config.ts`, `status.ts` and `quickstart.ts` are the `internal/cli` ports; their libraries are importable without the CLI framework:

- `domain/searchenv/index.ts` - `buildSearchEnvironment({ env?, fetch?, ... })` builds the `SearchEnvironment` every caller of the search library needs: the machine embedding registry (`EmbeddingSettingsStore`, `~/.knowns/settings.json`), the global semantic store (`~/.knowns/global`, opened lazily), the references adapter (`referenceExtractor`) and the `queueReindex` seam. MCP and the server call this instead of assembling their own. `searchRuntimeHooks.enqueueReindex` is the runtime-queue seam (a no-op until TSR-2MPMDK lands); the degraded-search notice already says `qdrant bootstrap/reindex queued` exactly as Go does, because Go reports the bootstrap as queued even when the enqueue itself fails.
- `commands/resolve-support.ts` - `storageReaders(storage)`, `resolveRaw(storage, ref)` and `resolveStructural(storage, ref, params)` (Store.ResolveRawReference / StructuralResolve) over the history library's resolvers.
- `commands/search-support.ts` - result grouping and the plain / styled renderers; `commands/config-gitignore.ts` - `writeKnownsGitignore` (also needed by `init`).

Not ported yet, and failing with an explicit message rather than pretending: `search --reindex`, `search index` and `search index --wait` (they need the semantic index writer and the runtime queue), and the interactive `settings` command (huh forms; still a root-help placeholder). Go's `search*` warning, dim and success styles, and `RenderBadge`, are built outside Go's plain / `NO_COLOR` switch, so they keep their colours there; the port reproduces that for byte parity.

The doc commands' pure helpers (sections, line ranges, headings, slugs, history formatting and Go-ordered history JSON) are exported from `src/cli/commands/doc-support.ts` and `doc-history.ts`. Two seams are inert until their owners land: `docHooks` in `commands/doc-hooks.ts` (background search indexing after a doc mutation, and the reconciler behind `doc hard-delete`).

## CLI framework

`src/cli/core/` is the shared CLI layer ported from `internal/cli` (`root.go`, `helpgroups.go`, `exit.go`, `plainoutput.go`, `pager.go`, `markdown.go`, `helpers.go`). Entity commands plug into it from `src/cli/commands/`; they never edit core.

### Why a bespoke parser

The Go CLI is cobra + pflag, and its observable text is part of the contract: `Error: unknown flag: --x` followed by the usage block, the `Did you mean this?` suggestion, the `invalid argument "x" for "--page" flag: strconv.ParseInt: ...` family, the way `stripFlags` finds the subcommand when a flag value is in the way, which flags `-h` and `-v` reach. commander and yargs produce different text and different lookup rules, so matching cobra through them means overriding most of their output. `core/command.ts`, `core/flags.ts` and `core/gofmt.ts` instead reproduce the parts of cobra v1.10.2 and pflag v1.0.9 the CLI uses (about 1,300 lines, no dependencies), and `test/cli/golden.test.ts` holds the result byte-for-byte against the Go binary. Startup stays low because there is nothing to load beyond these files: `knowns --version` measures about 45 ms against the 150 ms D5 budget, and command modules are loaded lazily (below).

### Registering a command

A command is one file in `src/cli/commands/` plus one line in `src/cli/commands/index.ts`:

```ts
// src/cli/commands/audit.ts
import { defineCommand } from "../core/define.ts";

export default defineCommand({
  use: "audit",
  short: "Inspect MCP tool call audit trail",       // must equal the 0.34.1 summary
  subcommands: [
    defineCommand<Row[]>({
      use: "recent",
      short: "Show recent MCP tool calls",
      flags: [{ type: "int", name: "limit", usage: "Maximum number of events to show", default: 50 }],
      async run(ctx) {                                 // throw to fail; return the result to render it
        const store = await ctx.getStore();
        return recent(store, ctx.flags.int("limit"));
      },
      render: {                                        // one renderer per output mode
        styled: (rows) => rows.map(styledRow).join("\n") + "\n",
        plain: (rows) => rows.map(plainRow).join("\n") + "\n",   // falls back to styled; --page applies
        json: (rows) => rows,                          // falls back to the result itself
      },
    }),
  ],
});
```

```ts
// src/cli/commands/index.ts
audit: { load: () => import("./audit.ts") },
```

- `CommandSpec` fields (core/define.ts): `use`, `short`, `long`, `example`, `aliases`, `hidden`, `deprecated`, `flags`, `args` (`exactArgs(n)` and friends in core/args.ts), `flagGroups` (`requiredTogether`, `oneRequired`, `mutuallyExclusive`), `silenceUsage`, `silenceErrors`, `disableFlagParsing`, `flagError`, `persistentPreRun`, `subcommands`, `helpGroup`.
- Flags are declared with `{ type, name, shorthand, usage, default, hidden, noOptDefVal, deprecated, required, persistent }`. Types: `bool string int float64 duration stringArray stringSlice intSlice`. A back-quoted word in `usage` names the value in help, as in pflag. Read them with `ctx.flags.bool/string/int/float/strings/ints/changed(name)`; the root's `--plain --json --page --page-size --no-pager` are available to every command.
- `ctx.mode` is `"json"`, `"plain"` or `"styled"` (`--json` wins over `--plain`). Either print yourself (`ctx.print`, `ctx.printPaged`, `ctx.printJSON`, `ctx.printErr`) or return a value and give `render`. Styling helpers (`StyleInfo`, `renderSuccess`, ...) are in core/plainoutput.ts and turn themselves off in plain mode, under `--json`, and for `NO_COLOR`.
- Failure: any thrown `Error` exits 1 and prints `Error: <message>` plus the usage block (set `silenceUsage` to drop the usage); `throw exitError(code, cause)` picks another exit code; `throw new SilentExit(code)` after printing your own diagnostic prints nothing more (this is how `getStore` reproduces Go's `os.Exit(1)` sites).
- Help is rendered by core from the command tree (`Usage:`, `Commands:` ordered create/list/view/edit/other/destructive, `Options:`, `Global options:`); nothing per command.
- Root help placement: `core/helpgroups.ts` holds the 0.34.1 group table. A command in the table needs nothing. A TS-only root command passes `helpGroup: "<existing title>"` in its spec and in its `commands/index.ts` entry (`short`, `helpGroup`), otherwise it lands under "Other".
- Loaders are lazy: a module is imported only when the arguments select its command (`knowns task ...`, `knowns help task`). Root `--help` never loads one.

### Unported commands and the root help manifest

`knowns --help` must list the whole 0.34.1 command set while most commands are not ported. `core/help-manifest.generated.ts` records every 0.34.1 root command (name, one-line summary, hidden or not) captured from the Go binary by `scripts/capture-help-manifest.ts`. Root help, the `Available Commands` block of usage errors, cobra's name padding and unknown-command suggestions are rendered from it. A manifest command with no loader is a placeholder that is listed but, when run, fails with `Error: "knowns <name>" is not available in the TypeScript build yet (the command has not been ported)` and exit 1. It is never a partial implementation. Adding a loader replaces the placeholder; `test/cli/registry.test.ts` checks that the ported command's summary and hidden flag equal the manifest, and (with `KNOWNS_GO_BIN`) that the committed manifest equals a fresh capture from Go, so it cannot drift. Regenerate with `KNOWNS_GO_BIN=... bun scripts/capture-help-manifest.ts`.

Global flags are the 0.34.1 root set: `--plain --json --page --page-size` and the hidden no-op `--no-pager`, plus `-h/--help` and `-v/--version` on the root only. There is no root `--project`; the commands that take one declare it themselves.

Extension points owned by other subtasks (core never imports them): `core/hooks.ts` `runtimeHooks.checkForUpdate` (the update notice), `markdown.ts` `newTerminalMarkdownBodyRenderer` (see below).

Known gaps: `completion` (shell completion scripts) is a placeholder like the unported commands; `markdown.ts` ports Go's width and style selection but renders with Go's own raw fallback because glamour has no byte-identical TS equivalent; cobra's `__complete`, command groups, `SetFlagErrorFunc` chains and `TraverseChildren` are not used by the Go CLI and are not implemented.

### Tests

`test/cli/golden.test.ts` compares stdout, stderr and exit code with the Go binary for root help, `--version`, the banner, unknown commands (with suggestions), bad flags, group and leaf help, `help <path>`, and usage errors, for the root and for `audit` and `lsp` registered through the framework (their definitions in `test/cli/fixtures.ts` mirror `internal/cli/audit.go` and `lsp.go`). Run with `KNOWNS_GO_BIN=/path/to/knowns bun test test/cli`; the Go comparisons skip without it. The Go binary built without release ldflags calls itself `dev`; the harness normalizes that to `VERSION`.
