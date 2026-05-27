MODULE := github.com/howznguyen/knowns
BINARY := knowns
VERSION ?= $(shell git describe --tags 2>/dev/null || node -p "require('../knowns/package.json').version" 2>/dev/null || echo "dev")
LDFLAGS := -s -w -X $(MODULE)/internal/util.Version=$(VERSION)
BUILD_DIR := bin

# All 6 platform targets
PLATFORMS := \
	darwin/amd64 \
	darwin/arm64 \
	linux/amd64 \
	linux/arm64 \
	windows/amd64 \
	windows/arm64

.PHONY: all build clean test test-e2e test-e2e-semantic test-e2e-ui lint dev dev-go dev-ui dev-all install cross-compile ui embed npm-build release

all: ui build

# Development build (current platform)
build:
	CGO_ENABLED=1 go build -ldflags "$(LDFLAGS)" -o $(BUILD_DIR)/$(BINARY) ./cmd/knowns

# Development build with race detector (race requires CGO)
dev:
	CGO_ENABLED=1 go build -race -ldflags "$(LDFLAGS)" -o $(BUILD_DIR)/$(BINARY) ./cmd/knowns

# Run Go server with hot reload (requires air: go install github.com/air-verse/air@latest)
dev-go:
	@AIR_BIN="$$(command -v air || true)"; \
	if [ -z "$$AIR_BIN" ]; then \
		AIR_BIN="$$(go env GOPATH)/bin/air"; \
	fi; \
	if [ ! -x "$$AIR_BIN" ]; then \
		echo "air is required. Install with: go install github.com/air-verse/air@latest"; \
		exit 1; \
	fi; \
	"$$AIR_BIN" -c .air.toml

# Run frontend Vite dev server
dev-ui:
	cd ui && bun install && bun dev

# Run Go hot reload server and frontend Vite dev server together
dev-all:
	@trap 'kill 0' INT TERM EXIT; \
	$(MAKE) dev-go & \
	$(MAKE) dev-ui & \
	wait

# Install to GOPATH/bin
install:
	CGO_ENABLED=1 go install -ldflags "$(LDFLAGS)" ./cmd/knowns

# Run tests
test:
	go test -v -race -count=1 ./...

# Run E2E tests (requires built binary)
test-e2e: build
	@echo "Running CLI E2E tests..."
	cd tests && go test -v -timeout 300s -count=1 -run TestCLI ./...
	@echo "Running MCP E2E tests..."
	cd tests && go test -v -timeout 300s -count=1 -run TestMCP ./...

# Run E2E tests including semantic search (requires ONNX Runtime + model)
test-e2e-semantic: build
	@echo "Running ALL E2E tests (including semantic search)..."
	cd tests && TEST_SEMANTIC=1 go test -v -timeout 600s -count=1 ./...

# Run UI E2E tests with Playwright (requires built binary)
test-e2e-ui: all
	cd ui && bun test:e2e

test-ui-report: all
	cd ui && bun exec playwright show-report

# Run linter
lint:
	golangci-lint run ./...

# Cross-compile for all platforms (requires CGO toolchains for non-host targets;
# in CI this runs per-matrix on native runners)
cross-compile: clean
	@for platform in $(PLATFORMS); do \
		os=$$(echo $$platform | cut -d/ -f1); \
		arch=$$(echo $$platform | cut -d/ -f2); \
		output=$(BUILD_DIR)/$(BINARY)-$$os-$$arch; \
		if [ "$$os" = "windows" ]; then output="$$output.exe"; fi; \
		echo "Building $$os/$$arch..."; \
		GOOS=$$os GOARCH=$$arch CGO_ENABLED=1 go build -ldflags "$(LDFLAGS)" -o $$output ./cmd/knowns; \
	done

# Build for npm distribution (maps to npm package names)
npm-build: clean
	@echo "Building for npm distribution..."
	GOOS=darwin GOARCH=arm64 CGO_ENABLED=1 go build -ldflags "$(LDFLAGS)" -o npm/knowns-darwin-arm64/knowns ./cmd/knowns
	GOOS=darwin GOARCH=amd64 CGO_ENABLED=1 go build -ldflags "$(LDFLAGS)" -o npm/knowns-darwin-x64/knowns ./cmd/knowns
	GOOS=linux GOARCH=arm64 CGO_ENABLED=1 go build -ldflags "$(LDFLAGS)" -o npm/knowns-linux-arm64/knowns ./cmd/knowns
	GOOS=linux GOARCH=amd64 CGO_ENABLED=1 go build -ldflags "$(LDFLAGS)" -o npm/knowns-linux-x64/knowns ./cmd/knowns
	GOOS=windows GOARCH=arm64 CGO_ENABLED=1 go build -ldflags "$(LDFLAGS)" -o npm/knowns-win-arm64/knowns.exe ./cmd/knowns
	GOOS=windows GOARCH=amd64 CGO_ENABLED=1 go build -ldflags "$(LDFLAGS)" -o npm/knowns-win-x64/knowns.exe ./cmd/knowns

# Build UI (requires Node.js + bun)
ui:
	cd ui && bun install && bun run build


# Full release build: UI + cross-compiled Go binaries + npm staging
release: clean ui cross-compile npm-build
	@echo "Release artifacts ready in $(BUILD_DIR)/ and npm/"

clean:
	rm -rf $(BUILD_DIR)
	rm -f npm/knowns-*/knowns npm/knowns-*/knowns.exe
	rm -f npm/knowns-*/knowns-embed npm/knowns-*/knowns-embed.exe

# Generate embedded assets placeholder
embed:
	@echo "Embedding UI assets..."
	@if [ ! -f ui/dist/index.html ]; then \
		echo '<!DOCTYPE html><html><body>Build UI first: make ui</body></html>' > ui/dist/index.html; \
	fi
