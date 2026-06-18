---
title: Implementation Checklist
description: Step-by-step checklist for implementing new features in the Go codebase
createdAt: '2025-12-25T15:16:58.867Z'
updatedAt: '2026-06-18T09:52:21.854Z'
tags:
  - conventions
---

---

## New Feature

### Models (`internal/models/`)

- [ ] Define struct with exported fields and JSON/YAML tags
- [ ] Define constants using `iota` for status/enum types
- [ ] Add constructor function `New{Entity}(...)` with validation
- [ ] Implement `Validate()` method if needed

### Storage Layer (`internal/storage/`)

- [ ] Add methods to `Store` struct (e.g., `CreateTask`, `GetTask`, `UpdateTask`)
- [ ] Implement markdown frontmatter parsing with `go-yaml`
- [ ] Handle file I/O with `os` package (read/write/rename)
- [ ] Add version history support if needed

### CLI Layer (`internal/cli/`)

- [ ] Create `cobra.Command` in appropriate file (e.g., `task.go`)
- [ ] Register subcommand in `init()` function
- [ ] Add flags with `cmd.Flags()` or `cmd.PersistentFlags()`
- [ ] Implement `RunE` handler with proper error return
- [ ] Support `--plain` flag for AI-readable output
- [ ] Support `--json` flag for structured output

### MCP Layer (`internal/mcp/handlers/`)

- [ ] Add tool definition with input schema
- [ ] Add handler function in appropriate handler file
- [ ] Register tool in `internal/mcp/server.go`

### Testing

- [ ] Write unit tests in `*_test.go` files alongside source
- [ ] Use `testing.T` and table-driven tests
- [ ] Run with `go test ./internal/...`
- [ ] Run specific package: `go test ./internal/storage/`
- [ ] Check coverage: `go test -cover ./internal/...`

### Build and Run

- [ ] Build: `make build` or `go build ./cmd/knowns`
- [ ] Test: `make test` or `go test ./...`
- [ ] Lint: `make lint` or `golangci-lint run`
- [ ] Format: `gofmt -w .` or `goimports -w .`

### Knowledge Capture

- [ ] Ask whether the feature created, changed, or superseded durable project guidance
- [ ] Create a Decision for stable choices: architecture, product behavior, workflow convention, naming, storage model, API contract, or explicit tradeoff
- [ ] Link each Decision to a source task, source doc, or related reference
- [ ] Supersede older Decisions instead of overwriting them when guidance changes
- [ ] Use Memory for concise reusable recall and Docs for long-form explanations

### Package Structure

```
cmd/
  knowns/          # Main entry point (main.go)
internal/
  cli/             # Cobra commands
  codegen/         # Template engine (text/template)
  mcp/             # MCP server (mcp-go)
    handlers/      # Tool handler files
  models/          # Domain types and structs
  search/          # Search engine
  server/          # HTTP server (if applicable)
  storage/         # File-based storage (markdown + frontmatter)
  util/            # Shared utilities
```
## Security

- [ ] Validate all user input before processing
- [ ] Use `filepath.Clean()` to prevent path traversal
- [ ] Never log sensitive data
- [ ] Handle errors explicitly (no silent swallowing)
## Error Handling

- [ ] Return `error` as the last return value
- [ ] Wrap errors with context: `fmt.Errorf("failed to create task: %w", err)`
- [ ] Use `errors.Is()` / `errors.As()` for error checking
- [ ] Log errors at the CLI layer, return them from internal packages
## Related Docs

- @doc/guides/workflow-guide - Task workflow and durable knowledge capture
- @doc/architecture/patterns/command - Cobra Command Pattern
- @doc/architecture/patterns/storage - File-Based Storage Pattern
