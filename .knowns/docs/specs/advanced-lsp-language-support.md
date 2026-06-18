---
title: Advanced LSP Language Support
description: Specification for expanding Knowns LSP module with auto-download, per-language adapters, parallel startup, auto-restart, and broad language coverage
createdAt: '2026-05-20T10:53:19.385Z'
updatedAt: '2026-06-15T04:28:19.325Z'
tags:
  - spec,lsp,code-intelligence
---

## Overview

Expand the Knowns LSP module (`internal/lsp/`) from a minimal 5-language detect-only system to a full-featured architecture with per-language adapters, guided installation, parallel startup, auto-restart, dynamic lifecycle management, and broad language coverage.

Currently Knowns only checks if LSP binaries exist in PATH and silently skips missing ones. This spec adds clear guidance when binaries are missing, a `knowns lsp install` command for user-initiated downloads, and a robust runtime with crash recovery and parallel initialization.

## Locked Decisions

- D1: Language adapters are Go structs implementing a `LanguageAdapter` interface — each adapter encapsulates detection, download, configuration, and initialization logic for one language server
- D2: Auto-download is OFF by default. When a language is detected but binary is missing, Knowns displays install guidance. User must explicitly run `knowns lsp install <lang>` to download
- D3: Downloaded binaries are stored in `~/.knowns/lsp-servers/<language>/<version>/` — shared across projects
- D4: Parallel startup using goroutines with error collection — fail-open strategy: languages that fail to start are skipped with warning, remaining languages continue
- D5: Auto-restart on crash — lazy restart on next query (consistent with existing spec FR-16)
- D6: Per-language settings via `.knowns/config.json` field `lsp.languages.<id>.settings` — passed as `initializationOptions` to the LSP server
- D7: Runtime dependencies use SHA-256 verified downloads with platform-specific URLs (darwin-arm64, darwin-amd64, linux-amd64, linux-arm64, windows-amd64)
- D8: Registry remains the source of truth for supported languages — adapters register themselves at init time
- D9: Existing `internal/lsp/server.go` JSON-RPC implementation is retained and extended — no external LSP library dependency
- D10: Version pinning — each adapter declares a default version with SHA-256. Users can override version in config
- D11: LSP-only approach — no IDE plugin integration
- D12: Missing LSP guidance is surfaced in two places: `knowns status` CLI output AND MCP `initial_instructions` response when session starts

## Requirements

### Functional Requirements

- FR-1: Knowns MUST support a `LanguageAdapter` interface that encapsulates: binary detection, install command/URL, version checking, initialization params, and language-specific quirks
- FR-2: When a language is detected but its LSP binary is missing, Knowns MUST display clear install guidance (command to run + URL)
- FR-3: `knowns lsp install <language>` MUST download the LSP binary with SHA-256 verification — this is user-initiated, never automatic
- FR-4: Downloaded servers MUST be stored in a shared location (`~/.knowns/lsp-servers/`) reusable across projects
- FR-5: Users MUST be able to override the binary path for any language (`lsp.languages.<id>.binary`)
- FR-6: Users MUST be able to pass per-language settings (`lsp.languages.<id>.settings`) forwarded as `initializationOptions`
- FR-7: LSP servers MUST start in parallel using goroutines when multiple languages are detected
- FR-8: If a language server fails to start, Knowns MUST log a warning and continue with remaining languages (fail-open)
- FR-9: If a running LSP server crashes, Knowns MUST automatically restart it on the next query (lazy restart)
- FR-10: Knowns MUST support at minimum these languages at launch (Phase 1): Go, TypeScript/JavaScript, Python, Rust, C/C++ (clangd), Java (jdtls), C# (Roslyn), Ruby (ruby-lsp), PHP (intelephense)
- FR-11: Knowns MUST support these languages in Phase 2: Kotlin, Scala, Elixir, Haskell, Lua, Bash, Zig, Dart, Swift
- FR-12: Each adapter MUST declare: language ID, display name, file extensions, default binary name, default args, version check command, install command, install URL, download URLs per platform, and SHA-256 hashes
- FR-13: `knowns status` MUST report which LSP servers are available, which are missing with install guidance
- FR-14: `knowns lsp list` MUST show all supported languages with their status (not-installed, installed, running, disabled)
- FR-15: Adapters that require additional runtime dependencies (e.g., Java needs JDK, C# needs .NET SDK) MUST check prerequisites and provide clear error messages with install instructions
- FR-16: MCP `initial_instructions` MUST include missing LSP guidance when languages are detected but binaries are absent
- FR-17: `knowns lsp cleanup` MUST automatically remove old versions when a new version is installed
- FR-18: Users MUST be able to enable/disable languages via `.knowns/config.json` field `lsp.languages.<id>.enabled`

### Non-Functional Requirements

- NFR-1: `knowns lsp install` MUST verify SHA-256 checksums before marking binary as installed
- NFR-2: Download MUST use HTTPS only
- NFR-3: Parallel startup MUST complete within 30 seconds for typical projects (timeout per server: 15s)
- NFR-4: Binary storage MUST NOT exceed 500MB total without user consent
- NFR-5: The system MUST work on macOS (arm64, amd64), Linux (amd64, arm64), and Windows (amd64)
- NFR-6: Adding a new language adapter MUST require only implementing the `LanguageAdapter` interface and registering it — no changes to core infrastructure

## Architecture

### LanguageAdapter Interface

```go
type LanguageAdapter interface {
    // Identity
    ID() string
    Name() string
    Extensions() []string

    // Detection & Install Guidance
    Binaries() []BinaryCandidate
    Prerequisites() []Prerequisite
    CheckPrerequisites(ctx context.Context) error
    InstallGuide() InstallGuide

    // User-initiated download
    CanInstall() bool
    RuntimeDeps() []RuntimeDependency
    Install(ctx context.Context, targetDir string) (string, error)
    InstalledPath() (string, bool)

    // Configuration
    DefaultArgs() []string
    InitializeParams(root string, settings map[string]any) map[string]any
    InitializationOptions(settings map[string]any) map[string]any

    // Quirks
    IsIgnoredDir(name string) bool
    NormalizeSymbolName(name string) string
    SupportsImplementation() bool
    SupportsReferences() bool
}
```

### InstallGuide

```go
type InstallGuide struct {
    Command     string   // e.g. "go install golang.org/x/tools/gopls@latest"
    URL         string   // e.g. "https://pkg.go.dev/golang.org/x/tools/gopls"
    KnownsCmd   string   // e.g. "knowns lsp install go" (empty if not downloadable)
    Notes       string   // e.g. "Requires Go 1.21+ installed"
}
```

### RuntimeDependency

```go
type RuntimeDependency struct {
    ID          string
    PlatformID  string            // "darwin-arm64", "linux-amd64", etc.
    URL         string
    SHA256      string
    ArchiveType string            // "tar.gz", "zip", "binary"
    BinaryName  string            // name of executable inside archive
    ExtractPath string            // subdirectory inside archive
}
```

### Prerequisite

```go
type Prerequisite struct {
    Name        string            // "Java JDK 17+"
    CheckCmd    string            // "java -version"
    InstallHint string            // "Install from https://..."
}
```

### Enhanced Manager

```go
type Manager struct {
    root       string
    registry   *Registry
    detector   *Detector
    installer  *Installer
    config     Config

    mu         sync.Mutex
    clients    int
    servers    map[string]*Server
    adapters   map[string]LanguageAdapter
    status     map[string]ServerStatus
}

type ServerStatus int
const (
    StatusNotInstalled ServerStatus = iota
    StatusInstalled
    StatusStarting
    StatusRunning
    StatusCrashed
    StatusDisabled
)
```

### Installer

```go
type Installer struct {
    baseDir    string              // ~/.knowns/lsp-servers/
    mu         sync.Mutex
    installing map[string]chan struct{}
}

func (i *Installer) Install(ctx context.Context, adapter LanguageAdapter) (string, error)
func (i *Installer) IsInstalled(adapter LanguageAdapter) (string, bool)
func (i *Installer) Remove(languageID string) error
func (i *Installer) Cleanup(languageID string) error  // remove old versions
```

### Directory Layout

```
~/.knowns/lsp-servers/
├── go/
│   └── gopls-v0.17.1/
│       └── gopls
├── java/
│   └── jdtls-1.40.0/
│       ├── bin/jdtls
│       └── plugins/...
├── typescript/
│   └── typescript-language-server-4.3.3/
│       └── node_modules/.bin/typescript-language-server
├── csharp/
│   └── roslyn-4.12.0/
│       └── Microsoft.CodeAnalysis.LanguageServer
└── ...
```

### Config Schema Extension

```json
{
  "lsp": {
    "languages": {
      "go": {
        "enabled": true,
        "binary": "",
        "version": "",
        "settings": {
          "gopls_settings": {
            "buildFlags": ["-tags=integration"]
          }
        }
      },
      "java": {
        "enabled": true,
        "settings": {
          "java.home": "/usr/lib/jvm/java-17"
        }
      },
      "typescript": {
        "enabled": false
      }
    }
  }
}
```

### MCP Initial Instructions (missing LSP guidance)

When MCP session starts and languages are detected but binaries missing, include in initial_instructions:

```
⚠ Missing LSP servers:
  • java: jdtls not found
    → Run: knowns lsp install java
    → Or:  https://github.com/eclipse-jdtls/eclipse.jdt.ls
  • typescript: typescript-language-server not found
    → Run: npm install -g typescript-language-server

Code intelligence for these languages is unavailable until the required LSP servers are installed or configured.
```
## Acceptance Criteria

- [ ] AC-1: `LanguageAdapter` interface is defined and at least Go, TypeScript, Python, Rust adapters implement it
- [ ] AC-2: `knowns lsp list` shows all supported languages with status (not-installed/installed/running/disabled)
- [ ] AC-3: `knowns lsp install java` downloads jdtls to `~/.knowns/lsp-servers/java/` with SHA-256 verification
- [ ] AC-4: When Java files detected but jdtls missing, `knowns status` shows install guidance
- [ ] AC-5: When Java files detected but jdtls missing, MCP initial_instructions includes install guidance
- [ ] AC-6: Downloaded binary is reused across projects without re-downloading
- [ ] AC-7: If download fails (network error, checksum mismatch), clear error message shown to user
- [ ] AC-8: Multiple LSP servers start in parallel — startup time for 3 languages < 20s
- [ ] AC-9: If gopls crashes mid-session, next `code()` call restarts it transparently
- [ ] AC-10: `lsp.languages.java.settings` is forwarded as `initializationOptions` to jdtls
- [ ] AC-11: `lsp.languages.go.binary: "/custom/path/gopls"` overrides auto-detection
- [ ] AC-12: `knowns status` shows LSP server availability per language
- [ ] AC-13: Adding a new language requires only: implement `LanguageAdapter`, register in `init()` — no core changes
- [ ] AC-14: Phase 1 languages (Go, TS/JS, Python, Rust, C/C++, Java, C#, Ruby, PHP) all have working adapters
- [ ] AC-15: Prerequisites check provides clear error: "Java JDK 17+ required. Install from: https://..."
- [ ] AC-16: `knowns lsp cleanup` removes old versions after new version installed
- [ ] AC-17: No automatic downloads occur — all installs require explicit user action

## Scenarios

### Scenario 1: First-time Java project — guided install

**Given** a project with `.java` files and no jdtls installed
**When** user runs `knowns status`
**Then** output shows:
```
LSP Servers:
  ✓ go         gopls v0.17.1 (running)
  ✗ java       jdtls not found
               → Run: knowns lsp install java
               → Or:  https://github.com/eclipse-jdtls/eclipse.jdt.ls
               ⚠ Requires: JDK 17+
```

### Scenario 2: User installs via knowns

**Given** user sees guidance for missing jdtls
**When** user runs `knowns lsp install java`
**Then** Knowns downloads jdtls (SHA-256 verified), reports success, next MCP session starts jdtls automatically

### Scenario 3: MCP session with missing servers

**Given** project has Go + Java files, gopls in PATH, jdtls not installed
**When** MCP session starts
**Then** initial_instructions includes:
```
⚠ Missing LSP servers:
  • java: jdtls not found → Run: knowns lsp install java
```
**And** Java code intelligence returns a structured unavailable error until jdtls is installed or configured
**And** Go LSP works normally.

### Scenario 4: Custom binary path

**Given** config has `lsp.languages.go.binary: "/opt/gopls/bin/gopls"`
**When** Knowns detects Go files
**Then** uses `/opt/gopls/bin/gopls` instead of PATH lookup

### Scenario 5: Parallel startup with mixed results

**Given** project has Go, TypeScript, and Python files. gopls in PATH, typescript-language-server in PATH, pylsp not in PATH
**When** MCP session starts
**Then** Go and TypeScript servers start successfully, Python shows in initial_instructions as missing with guidance

### Scenario 6: Prerequisite check failure

**Given** user runs `knowns lsp install csharp` but has .NET 6 (needs 10+)
**When** install runs
**Then** returns error: "C# language server requires .NET SDK 10+. Found: .NET 6.0.100. Install from: https://dotnet.microsoft.com/download/dotnet/10.0"

### Scenario 7: knowns lsp list output

**Given** Go (running), TypeScript (installed, not running), Java (not installed), Rust (disabled)
**When** `knowns lsp list` is run
**Then** output shows:
```
Language     Status          Binary                          Install
go           running         gopls v0.17.1 (PATH)            —
typescript   installed       typescript-language-server v4.3.3  —
python       installed       pylsp v1.12.0 (PATH)            —
java         not-installed   —                               knowns lsp install java
rust         disabled        —                               —
c_cpp        not-installed   —                               knowns lsp install c_cpp
```

### Scenario 8: Version upgrade

**Given** jdtls v1.39.0 installed, adapter declares v1.40.0
**When** user runs `knowns lsp install java`
**Then** downloads v1.40.0, old v1.39.0 auto-cleaned after successful install

### Scenario 9: No automatic downloads

**Given** project with Java files, jdtls not installed
**When** MCP session starts
**Then** NO download is triggered
**And** only guidance plus structured unavailable status are shown for Java code intelligence.
## Technical Notes

### Phase 1 Adapters (Priority)

| Language | Binary | Downloadable via `knowns lsp install` | Prerequisites |
|----------|--------|--------------------------------------|---------------|
| Go | gopls | No (user runs `go install`) | Go 1.21+ |
| TypeScript/JS | typescript-language-server | Yes (npm global) | Node.js 18+ |
| Python | pylsp / pyright-langserver | Yes (pip/npm) | Python 3.9+ / Node.js 18+ |
| Rust | rust-analyzer | Yes (GitHub release) | None (standalone) |
| C/C++ | clangd | Yes (GitHub release) | None (standalone) |
| Java | jdtls | Yes (Eclipse download) | JDK 17+ |
| C# | Roslyn LS | Yes (.NET tool) | .NET SDK 10+ |
| Ruby | ruby-lsp | No (user runs `gem install`) | Ruby 3.1+ |
| PHP | intelephense | Yes (npm global) | Node.js 18+ |

### Phase 2 Adapters

| Language | Binary | Downloadable | Prerequisites |
|----------|--------|--------------|---------------|
| Kotlin | kotlin-lsp | Yes (GitHub release) | JDK 17+ |
| Scala | metals | Yes (coursier) | JDK 11+ |
| Elixir | elixir-ls / lexical | Yes (GitHub release) | Elixir 1.14+ |
| Haskell | haskell-language-server | Yes (ghcup) | GHC |
| Lua | lua-language-server | Yes (GitHub release) | None |
| Bash | bash-language-server | Yes (npm) | Node.js 18+ |
| Zig | zls | Yes (GitHub release) | Zig |
| Dart | dart language-server | No (bundled with Dart SDK) | Dart SDK |
| Swift | sourcekit-lsp | No (bundled with Swift) | Swift toolchain |

### Resolution Strategy (per language)

1. Check config `lsp.languages.<id>.binary` override → use if set
2. Check `InstalledPath()` in `~/.knowns/lsp-servers/` → use if found
3. Check PATH via `LookPath` → use if found
4. None found → add to missing list, show guidance, and return a structured unavailable error for that language's LSP-backed code intelligence

### Migration from Current System

- Existing `BuiltinLanguages()` in `registry.go` becomes adapter registrations
- Existing `Detector.Detect()` delegates to adapter `Binaries()` + `InstalledPath()`
- Existing `Config` struct extends with new fields (backward compatible)
- Existing `Server` struct unchanged — adapters produce `ServerCommand` consumed by `Server`
- No breaking changes to MCP tool interface

### Relationship to Existing Specs

- @doc/specs/lsp-enriched-code-intelligence — this spec extends the LSP infrastructure defined there
- @doc/specs/delta-based-code-re-indexing — unchanged, works with any LSP server
- @doc/specs/remove-tree-sitter-lsp-only-code-intelligence — later design removes tree-sitter from code intelligence; missing LSP servers should surface install guidance and structured unavailable errors
## Resolved Questions

- RQ-1: `knowns lsp cleanup` automatically removes old versions when a new version is successfully installed via `knowns lsp install`
- RQ-2: npm-based servers (typescript-language-server, intelephense, bash-language-server) use global npm install (`npm install -g`). Knowns checks if the package is already globally installed at the correct version before installing
- RQ-3: User-contributed adapters are supported via a plugin directory at `~/.knowns/lsp-adapters/`. Each plugin is a JSON manifest declaring the same fields as a built-in adapter (ID, extensions, binary, args, download URLs, prerequisites). Knowns loads these at startup and merges them with built-in adapters. Plugin adapters can override built-in ones by matching the same language ID
