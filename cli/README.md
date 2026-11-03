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

`adaptTasks`, `adaptDocs`, `adaptMemory` (adds `canonicalHash` and per-id locks) and `adaptTime` (adds `writeEntriesFile`) implement the history ports. Two things are injected, not wired: `opts.rewriteDocPath` (the reference extractor; the default throws so a rename can never silently skip reference rewriting) and the lifecycle purge reconciler (passed to `purgeTaskLifecycle`).

`ConfigStore` keeps Go's `statuses` null versus `[]` distinction (absent and `null` stay `null`). `Manager.switch` registers and activates the project through the stores `Registry` and, like Go, ignores a registry failure.
