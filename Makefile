MODULE := github.com/howznguyen/knowns
BINARY := knowns
VERSION ?= $(shell git describe --tags 2>/dev/null || node -p "require('../knowns/package.json').version" 2>/dev/null || echo "dev")
LDFLAGS := -s -w -X $(MODULE)/internal/util.Version=$(VERSION)
BUILD_DIR := bin
RUNTIME_DOCKER_IMAGE ?= knowns-runtime-smoke
RUNTIME_DOCKER_CONTAINER ?= knowns-runtime-smoke-run
RUNTIME_DOCKER_LSP_IMAGE ?= knowns-lsp-fixtures
RUNTIME_DOCKER_LSP_CONTAINER ?= knowns-lsp-fixtures-run
RUNTIME_DOCKER_VERSION ?= dev-$(shell git rev-parse --short HEAD 2>/dev/null || echo local)-$(shell date +%s)
RUNTIME_DOCKER_MEMORY ?= 768m
RUNTIME_DOCKER_PIDS ?= 512
RUNTIME_DOCKER_MCP_CLIENTS ?= 3
RUNTIME_DOCKER_MCP_CALLS ?= 1
RUNTIME_DOCKER_MCP_HOLD_SECONDS ?= 1
RUNTIME_DOCKER_SEARCH_MODE ?= keyword
RUNTIME_DOCKER_RUN_CODE ?= 0
RUNTIME_DOCKER_AI_SESSIONS ?= 3
RUNTIME_DOCKER_PROJECT ?= $(CURDIR)
RUNTIME_DOCKER_PROJECT_CONTAINER ?= knowns-runtime-project-stress-run
RUNTIME_DOCKER_PROJECT_QUERY ?= knowns runtime MCP
RUNTIME_DOCKER_PROJECT_CODE_PATH ?= cmd/knowns/main.go
RUNTIME_DOCKER_PROJECT_HOLD_SECONDS ?= 1
RUNTIME_DOCKER_USER ?= $(shell id -u):$(shell id -g)
RUNTIME_DOCKER_VERBOSE ?= 0
RUNTIME_DOCKER_USE_ONNX ?= 0
RUNTIME_DOCKER_ONNX_MODEL ?= gte-small
RUNTIME_DOCKER_ONNX_REINDEX ?= 1
RUNTIME_DOCKER_EMBED_BATCH_SIZE ?= 8
RUNTIME_DOCKER_LSP_STRESS ?= 0
RUNTIME_DOCKER_LSP_PATHS ?= cmd/knowns/main.go,ui/src/lib/utils.ts,ui/src/api/client.ts,tests/runtime-docker/fixtures/csharp/Program.cs
RUNTIME_DOCKER_GOPLS_VERSION ?= v0.20.0

# All 6 platform targets
PLATFORMS := \
	darwin/amd64 \
	darwin/arm64 \
	linux/amd64 \
	linux/arm64 \
	windows/amd64 \
	windows/arm64

.PHONY: all build clean test test-e2e test-e2e-semantic test-e2e-ui lint dev dev-go dev-ui dev-all install cross-compile ui embed npm-build release runtime-docker-build runtime-docker-smoke runtime-docker-project-stress runtime-docker-ai-stress runtime-docker-shell runtime-docker-lsp-build runtime-docker-lsp-fixtures

all: ui build

# Development build (current platform)
build:
	CGO_ENABLED=1 go build -ldflags "$(LDFLAGS)" -o $(BUILD_DIR)/$(BINARY) ./cmd/knowns

# Build the Linux Docker smoke image. The Dockerfile builds UI assets first,
# then builds the Go binary inside Linux so the runtime image never uses a
# host-OS binary.
runtime-docker-build:
	docker build \
		-f tests/runtime-docker/Dockerfile \
		--target runtime \
		--build-arg VERSION=$(RUNTIME_DOCKER_VERSION) \
		--build-arg GOPLS_VERSION=$(RUNTIME_DOCKER_GOPLS_VERSION) \
		-t $(RUNTIME_DOCKER_IMAGE) \
		.

# Build and run the Linux image that installs the five managed recommended
# LSPs and executes their real external-server fixture suite.
runtime-docker-lsp-build:
	docker build \
		-f tests/runtime-docker/Dockerfile \
		--target lsp-fixtures \
		--build-arg VERSION=$(RUNTIME_DOCKER_VERSION) \
		--build-arg GOPLS_VERSION=$(RUNTIME_DOCKER_GOPLS_VERSION) \
		-t $(RUNTIME_DOCKER_LSP_IMAGE) \
		.

runtime-docker-lsp-fixtures: runtime-docker-lsp-build
	@docker rm -f $(RUNTIME_DOCKER_LSP_CONTAINER) >/dev/null 2>&1 || true
	@set +e; \
	docker run \
		--pull=never \
		--name $(RUNTIME_DOCKER_LSP_CONTAINER) \
		--memory=$(RUNTIME_DOCKER_MEMORY) \
		--memory-swap=$(RUNTIME_DOCKER_MEMORY) \
		--pids-limit=$(RUNTIME_DOCKER_PIDS) \
		$(RUNTIME_DOCKER_LSP_IMAGE); \
	status=$$?; \
	echo "=== docker inspect OOM state ==="; \
	docker inspect -f 'oom={{.State.OOMKilled}} exit={{.State.ExitCode}} error={{.State.Error}}' $(RUNTIME_DOCKER_LSP_CONTAINER) || true; \
	oom=$$(docker inspect -f '{{.State.OOMKilled}}' $(RUNTIME_DOCKER_LSP_CONTAINER) 2>/dev/null || echo false); \
	docker rm -f $(RUNTIME_DOCKER_LSP_CONTAINER) >/dev/null 2>&1 || true; \
	if [ "$$oom" = "true" ]; then exit 137; fi; \
	exit $$status

# Run the runtime/daemon smoke test from the already-built local image under
# a memory and PID cap, then print Docker's OOM state even if the smoke exits
# non-zero.
runtime-docker-smoke:
	@docker image inspect $(RUNTIME_DOCKER_IMAGE) >/dev/null 2>&1 || { \
		echo "Docker image $(RUNTIME_DOCKER_IMAGE) not found. Run: make runtime-docker-build"; \
		exit 1; \
	}
	@docker rm -f $(RUNTIME_DOCKER_CONTAINER) >/dev/null 2>&1 || true
	@set +e; \
	docker run \
		--pull=never \
		--name $(RUNTIME_DOCKER_CONTAINER) \
		--memory=$(RUNTIME_DOCKER_MEMORY) \
		--memory-swap=$(RUNTIME_DOCKER_MEMORY) \
		--pids-limit=$(RUNTIME_DOCKER_PIDS) \
		-e MCP_CLIENTS=$(RUNTIME_DOCKER_MCP_CLIENTS) \
		-e MCP_CALLS=$(RUNTIME_DOCKER_MCP_CALLS) \
		-e MCP_HOLD_SECONDS=$(RUNTIME_DOCKER_MCP_HOLD_SECONDS) \
		-e MCP_SEARCH_MODE=$(RUNTIME_DOCKER_SEARCH_MODE) \
		-e RUN_CODE=$(RUNTIME_DOCKER_RUN_CODE) \
		-e VERBOSE=$(RUNTIME_DOCKER_VERBOSE) \
		$(RUNTIME_DOCKER_IMAGE); \
	status=$$?; \
	echo "=== docker inspect OOM state ==="; \
	docker inspect -f 'oom={{.State.OOMKilled}} exit={{.State.ExitCode}} error={{.State.Error}}' $(RUNTIME_DOCKER_CONTAINER) || true; \
	oom=$$(docker inspect -f '{{.State.OOMKilled}}' $(RUNTIME_DOCKER_CONTAINER) 2>/dev/null || echo false); \
	docker rm -f $(RUNTIME_DOCKER_CONTAINER) >/dev/null 2>&1 || true; \
	if [ "$$oom" = "true" ]; then exit 137; fi; \
	exit $$status

# Run 3 AI-session-like MCP stdio clients against this repository mounted into
# the container. This uses the already-built image and does not rebuild.
runtime-docker-project-stress:
	@docker image inspect $(RUNTIME_DOCKER_IMAGE) >/dev/null 2>&1 || { \
		echo "Docker image $(RUNTIME_DOCKER_IMAGE) not found. Run: make runtime-docker-build"; \
		exit 1; \
	}
	@docker rm -f $(RUNTIME_DOCKER_PROJECT_CONTAINER) >/dev/null 2>&1 || true
	@set +e; \
	docker run \
		--pull=never \
		--name $(RUNTIME_DOCKER_PROJECT_CONTAINER) \
		--user $(RUNTIME_DOCKER_USER) \
		--memory=$(RUNTIME_DOCKER_MEMORY) \
		--memory-swap=$(RUNTIME_DOCKER_MEMORY) \
		--pids-limit=$(RUNTIME_DOCKER_PIDS) \
		-v "$(RUNTIME_DOCKER_PROJECT):/workspace/project" \
		-e HOME=/tmp/knowns-home \
		-e PROJECT=/workspace/project \
		-e MCP_CLIENTS=$(RUNTIME_DOCKER_AI_SESSIONS) \
		-e MCP_CALLS=$(RUNTIME_DOCKER_MCP_CALLS) \
		-e MCP_SEARCH_MODE=$(RUNTIME_DOCKER_SEARCH_MODE) \
		-e RUN_CODE=$(RUNTIME_DOCKER_RUN_CODE) \
		-e "MCP_QUERY=$(RUNTIME_DOCKER_PROJECT_QUERY)" \
		-e MCP_CODE_PATH=$(RUNTIME_DOCKER_PROJECT_CODE_PATH) \
		-e MCP_HOLD_SECONDS=$(RUNTIME_DOCKER_PROJECT_HOLD_SECONDS) \
		-e VERBOSE=$(RUNTIME_DOCKER_VERBOSE) \
		-e USE_ONNX=$(RUNTIME_DOCKER_USE_ONNX) \
		-e ONNX_MODEL=$(RUNTIME_DOCKER_ONNX_MODEL) \
		-e ONNX_REINDEX=$(RUNTIME_DOCKER_ONNX_REINDEX) \
		-e KNOWNS_EMBED_BATCH_SIZE=$(RUNTIME_DOCKER_EMBED_BATCH_SIZE) \
		-e LSP_STRESS=$(RUNTIME_DOCKER_LSP_STRESS) \
		-e "LSP_PATHS=$(RUNTIME_DOCKER_LSP_PATHS)" \
		--entrypoint /usr/bin/zsh \
		$(RUNTIME_DOCKER_IMAGE) /opt/knowns/project_stress.zsh; \
	status=$$?; \
	echo "=== docker inspect OOM state ==="; \
	docker inspect -f 'oom={{.State.OOMKilled}} exit={{.State.ExitCode}} error={{.State.Error}}' $(RUNTIME_DOCKER_PROJECT_CONTAINER) || true; \
	oom=$$(docker inspect -f '{{.State.OOMKilled}}' $(RUNTIME_DOCKER_PROJECT_CONTAINER) 2>/dev/null || echo false); \
	docker rm -f $(RUNTIME_DOCKER_PROJECT_CONTAINER) >/dev/null 2>&1 || true; \
	if [ "$$oom" = "true" ]; then exit 137; fi; \
	exit $$status

runtime-docker-ai-stress: runtime-docker-project-stress

runtime-docker-shell: runtime-docker-build
	docker run --rm -it \
		--entrypoint /usr/bin/zsh \
		--memory=$(RUNTIME_DOCKER_MEMORY) \
		--memory-swap=$(RUNTIME_DOCKER_MEMORY) \
		--pids-limit=$(RUNTIME_DOCKER_PIDS) \
		$(RUNTIME_DOCKER_IMAGE) -l

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
