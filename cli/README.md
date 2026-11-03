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
