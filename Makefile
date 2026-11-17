# Knowns is the TypeScript CLI in cli/ (Bun) plus the web UI in ui/. The Go implementation was
# removed after 0.35.0; differential tests still compare against Go built from a pinned commit
# (cli/scripts/go-oracle.ts, `make go-oracle`).

# Host Bun compile target, e.g. bun-darwin-arm64. Override: make build HOST_TARGET=bun-linux-x64
HOST_OS := $(shell uname -s | tr '[:upper:]' '[:lower:]' | sed -e 's/mingw.*/windows/' -e 's/msys.*/windows/')
HOST_ARCH := $(shell uname -m | sed -e 's/x86_64/x64/' -e 's/aarch64/arm64/')
HOST_TARGET ?= bun-$(HOST_OS)-$(HOST_ARCH)
HOST_BIN := cli/dist/$(HOST_OS)-$(HOST_ARCH)/knowns$(if $(filter windows,$(HOST_OS)),.exe,)

.PHONY: all build ui test test-e2e test-e2e-semantic test-e2e-ui test-ui-report lint cli-docs cli-docs-check \
	dev-ui dev-ts dev-all-ts go-oracle clean ts-build ts-release ts-test-dist

all: ui build

# Host binary at $(HOST_BIN). The version is KNOWNS_VERSION, else an exact tag on HEAD, else
# 0.0.0-dev (cli/scripts/version.ts).
build:
	cd cli && bun install && bun run gen && bun run build $(HOST_TARGET)

ui:
	cd ui && bun install && bun run build

# Typecheck, lint, then the whole suite. Differential tests skip without the Go oracle; to run
# them: eval "$$(cd cli && bun scripts/go-oracle.ts)" && make test
test:
	cd cli && bun run check && bun run test

# CLI and MCP end-to-end suites against the compiled host binary.
test-e2e: build
	cd cli && KNOWNS_TS_BIN="$(CURDIR)/$(HOST_BIN)" bun test test/e2e

# Also the TEST_SEMANTIC subsets (they need no reachable embedder).
test-e2e-semantic: build
	cd cli && TEST_SEMANTIC=1 KNOWNS_TS_BIN="$(CURDIR)/$(HOST_BIN)" bun test test/e2e

# UI Playwright suite against the compiled host binary.
test-e2e-ui: all
	cd ui && TEST_BINARY="$(CURDIR)/$(HOST_BIN)" bun test:e2e

test-ui-report: all
	cd ui && bun exec playwright show-report

lint:
	cd cli && bun run check

# Print the env for the Go parity oracle (pinned last-Go commit). Use: eval "$$(make -s go-oracle)"
go-oracle:
	@cd cli && bun scripts/go-oracle.ts

# Regenerate the human CLI reference from the TypeScript command tree.
cli-docs:
	cd cli && bun scripts/gen-cli-docs.ts

# Fail if the committed CLI reference drifted from the command tree, or if a hand-written doc
# shows a command or flag the binary does not have.
cli-docs-check:
	cd cli && bun scripts/gen-cli-docs.ts --check
	cd cli && bun scripts/gen-cli-docs.ts --lint

# Run frontend Vite dev server
dev-ui:
	cd ui && bun install && bun dev

# Run the TypeScript CLI web server for UI development (API on :6420). The TS server accepts only
# its own Origin, so the Vite dev UI (dev-ui, :6421) must be listed explicitly: KNOWNS_ALLOWED_ORIGINS
# takes exact origins (scheme://host:port), comma-separated, no wildcards. Both loopback spellings
# are listed because the match is exact. Override on the command line.
KNOWNS_ALLOWED_ORIGINS ?= http://localhost:6421,http://127.0.0.1:6421
dev-ts:
	cd cli && KNOWNS_ALLOWED_ORIGINS="$(KNOWNS_ALLOWED_ORIGINS)" bun src/main.ts browser --restart --dev --port 6420 --no-open

# Run the TypeScript web server and the frontend Vite dev server together
dev-all-ts:
	@trap 'kill 0' INT TERM EXIT; \
	$(MAKE) dev-ts & \
	$(MAKE) dev-ui & \
	wait

clean:
	rm -rf cli/dist release

# All 6 targets into cli/dist/<platform>/.
ts-build:
	cd cli && bun run build

# Builds all 6 targets and stages release/npm/<pkg> plus release/assets/knowns-<platform>.tar.gz.
ts-release: ts-build
	bun scripts/package-release.ts --version "$$(cd cli && bun -e 'import { resolveVersion } from "./scripts/version.ts"; console.log(resolveVersion())')" --dist cli/dist --out release

# Install script, packaging and version tests (KNOWNS_NETWORK_TESTS=1 adds the 0.34.x rollback check).
ts-test-dist:
	cd cli && bun test test/distribution
