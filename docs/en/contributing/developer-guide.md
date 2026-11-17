# Developer Guide

Start here if you are contributing to Knowns.

## Read first

1. `README.md`
2. `docs/en/README.md`
3. MCP `initial` and on-demand `help` output when working through an AI assistant

## Important directories

- `cli/src/cli/` - command framework and commands
- `cli/src/mcp/handlers/` - MCP tool handlers
- `cli/src/search/` - chunking, embeddings, lexical and vector search
- `cli/src/domain/` - shared library code (codegen, validation, decision review, and more)
- `cli/src/storage/` - stores, locks, history
- `cli/instructions/` - skills (`kn-*`) and guidelines, embedded by `cli/scripts/gen-instructions.ts`
- `cli/test/` - unit tests, differential tests, and e2e tests (`cli/test/e2e`)
- `ui/`

Go was removed from the repository after 0.35.0. There is nothing to build or test with Go.

## Useful commands

Requires Bun 1.3.12+.

```bash
make ui                 # build the Web UI the binary embeds
make build              # host binary -> cli/dist/<os>-<arch>/knowns
make ts-build           # all 6 targets
make test               # cd cli && bun run check && bun run test
make test-e2e           # cli/test/e2e against the compiled binary (KNOWNS_TS_BIN)
make test-e2e-semantic  # the same suite with the semantic search test enabled
make test-e2e-ui        # Playwright UI e2e
make lint               # bun run check (typecheck + Biome)
make dev-ts             # TypeScript server only
make dev-ui             # Vite dev UI only
make dev-all-ts         # TypeScript server + Vite dev UI
```

The differential tests compare the CLI with Go 0.34.1, built from the pinned commit `069954a`. They need a Go toolchain and skip without one:

```bash
eval "$(make -s go-oracle)"   # runs cli/scripts/go-oracle.ts, exports KNOWNS_GO_SRC and KNOWNS_GO_BIN
cd cli && bun run test
```

## Working rule of thumb

When behavior changes, keep code, tests, and docs aligned in the same pass whenever possible.
