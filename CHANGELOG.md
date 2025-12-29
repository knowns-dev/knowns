# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] - 2025-12-30

### Fixed
- **Kanban Drag-Drop**: Fixed cards not being droppable into empty columns
  - Implemented custom multi-strategy collision detection algorithm
  - Strategy 1: Pointer position detection (most intuitive for users)
  - Strategy 2: Rectangle intersection for overlapping elements
  - Strategy 3: Extended bounds with 150px buffer for near-column detection
  - Strategy 4: Closest corners fallback for edge cases
  - Dragging is now much smoother and easier

### Changed
- **MCP Integration Docs**: Updated `docs/mcp-integration.md` with complete tool reference
  - Added all 15 MCP tools with parameters
  - Added time tracking and board tools
  - Added troubleshooting section for `--verbose` and `--info` flags
  - Added resources section with links to official docs

## [0.3.0] - 2025-12-29

### Added
- **CLI Shorthand Commands**: New concise syntax for common operations
  - `knowns task <id>` - Shorthand for `knowns task view <id>`
  - `knowns doc <path>` - Shorthand for `knowns doc view <path>`
  - Reduces typing while maintaining full command compatibility

- **New UI Components** (shadcn/ui):
  - Badge, Card, Checkbox, Label, Progress, Select components
  - Data Table with sorting, filtering, and pagination
  - Dropdown Menu for context actions
  - Kanban board components (Column, Card, Board)
  - Sonner for toast notifications
  - Table component for data display

- **New React Contexts**:
  - `ConfigContext` - Global configuration state management
  - `TimeTrackerContext` - Time tracking state across components
  - `UIPreferencesContext` - User UI preferences persistence

- **Server Architecture**:
  - `src/server/middleware/` - Request processing middleware
  - `src/server/routes/` - Modular route handlers
  - `src/server/utils/` - Server utility functions
  - `src/server/types.ts` - TypeScript type definitions

- **Documentation**:
  - `docs/developer-guide.md` - Developer setup and contribution guide
  - `docs/user-guide.md` - End-user documentation

- **Utilities**:
  - `src/ui/utils/colors.ts` - Color utility functions for UI
  - `src/ui/utils/markdown-sections.ts` - Markdown section parsing

### Changed
- **UI Architecture**: Migrated to Atomic Design pattern
  - `atoms/` - Basic UI building blocks (buttons, inputs, icons)
  - `molecules/` - Composed components (form fields, cards)
  - `organisms/` - Complex UI sections (forms, lists, modals)
  - `templates/` - Page layout templates
  - Improved component reusability and maintainability

- **Server Refactoring**: Modularized monolithic server
  - Split 567-line `server/index.ts` into focused modules
  - Cleaner separation of concerns
  - Easier testing and maintenance

- **Page Components**: Simplified and optimized
  - `TasksPage` - Reduced from 700+ to ~300 lines
  - `DocsPage` - Streamlined document management
  - `KanbanPage` - Enhanced board functionality
  - `ConfigPage` - Improved settings interface

- **API Client**: Enhanced `src/ui/api/client.ts`
  - Better error handling
  - Type-safe API calls
  - Improved response parsing

- **Guidelines**: Updated AI agent guidelines
  - Clearer reference format documentation
  - Better examples for input vs output formats
  - Improved workflow instructions

### Removed
- **Legacy Components**: Cleaned up old monolithic components
  - `ActivityFeed.tsx`, `AppSidebar.tsx`, `AssigneeDropdown.tsx`
  - `Avatar.tsx`, `Board.tsx`, `Column.tsx`
  - `MarkdownRenderer.tsx`, `NotificationBell.tsx`
  - `SearchBox.tsx`, `SearchCommandDialog.tsx`
  - `TaskCard.tsx`, `TaskCreateForm.tsx`, `TaskDetailModal.tsx`
  - `TaskHistoryPanel.tsx`, `TimeTracker.tsx`, `VersionDiffViewer.tsx`
  - Functionality preserved in new Atomic Design components

### Fixed
- **Dialog/Sheet Components**: Fixed accessibility and styling issues
- **Mention Refs**: Improved reference parsing reliability
- **Server Notifications**: Better WebSocket notification handling

## [0.2.1] - 2025-12-28

### Fixed
- **Web UI Static Files**: Fixed `NotFoundError` when running `knowns browser` from global install
  - Bun creates symlinks in `~/.bun/bin/` which broke path resolution for UI files
  - Added `realpathSync` to resolve symlinks before computing paths
  - Changed Express `sendFile` to use `root` option for reliable file serving

## [0.2.0] - 2025-12-27

### Added
- **Project Documentation**: Comprehensive project docs for contributors and users
  - `PHILOSOPHY.md` - 10 core principles guiding Knowns design
  - `ARCHITECTURE.md` - Technical overview, diagrams, data flow, sync logic
  - `CONTRIBUTING.md` - Contribution guidelines aligned with philosophy
  - `docs/` folder with detailed guides:
    - `commands.md` - Full CLI command reference
    - `workflow.md` - Task lifecycle guide
    - `reference-system.md` - How `@doc/` and `@task-` linking works
    - `web-ui.md` - Kanban board and document browser guide
    - `mcp-integration.md` - Claude Desktop MCP setup
    - `configuration.md` - Project structure and options
    - `ai-workflow.md` - Guide for AI agents

- **README Improvements**:
  - Added TL;DR section for quick understanding
  - Added comparison table vs Notion/Jira/Obsidian
  - Added "How it works" 3-step explanation
  - Added Roadmap section with Self-Hosted Team Sync (planned)
  - New badges: Node version, TypeScript, Platform, GitHub stars, PRs welcome
  - Links to Philosophy, Architecture, and Contributing docs

- **Node.js Engine Requirement**: Added `engines.node >= 18.0.0` to package.json

### Changed
- **README Restructure**: Optimized for first impressions
  - Moved detailed docs to `./docs/` folder
  - Shortened main README from ~300 to ~175 lines
  - Documentation table links to detailed guides
- **Tagline**: Updated to "CLI-first knowledge layer that gives AI persistent memory of your project"
- **Version Display**: Now reads directly from package.json (works with both npm and bun)

### Fixed
- **UI Version Display**: Fixed version showing "dev" or old version when built with bun
  - Vite config now reads version directly from package.json instead of `npm_package_version`
- **Doc Mention Regex**: Fixed badge not rendering for `@doc/path` without `.md` extension
  - Changed regex from `/@doc\/([^\s]+\.md)/g` to `/@docs?\/([^\s)]+)/g`
  - Added `normalizeDocPath()` to automatically add `.md` extension

## [0.1.8] - 2025-12-27

### Added
- **Node.js Runtime Support**: Browser command now works with both Bun and Node.js
  - Migrated server from `Bun.serve()` to Express + ws
  - Added `express`, `ws`, and `cors` dependencies
  - WebSocket real-time sync works on both runtimes
- **Bun Compatibility Layer**: New `src/utils/bun-compat.ts` utility providing cross-runtime support
  - `file()` - Bun.file() compatible wrapper for reading files
  - `write()` - Bun.write() compatible wrapper for writing files
  - `bunSpawn()` - Bun.spawn() compatible wrapper for process spawning
  - CLI commands now work with both Bun and Node.js runtimes
- **Build Scripts**: Added `scripts/build-cli.js` using esbuild for Node.js-compatible builds
  - CLI can now be built with `node scripts/build-cli.js` (no Bun required)
  - Uses ESM format with `createRequire` shim for CommonJS compatibility
  - Builds both main CLI and MCP server
  - Properly strips old shebangs and adds Node.js-compatible shebang
- **CI/CD**: Updated GitHub Actions workflows to use only Node.js and npm
  - Removed Bun dependency from CI/CD pipelines
  - Both `ci.yml` and `publish.yml` now use `npm ci`, `npm test`, `npm run build`
  - Added npm cache for faster builds
- **Testing**: Migrated from `bun test` to `vitest`
  - Added `vitest.config.ts` with path aliases support
  - All 76 tests passing with vitest

### Fixed
- **File Deletion**: Fixed improper file deletion that was clearing files instead of deleting them
  - Changed from `Bun.write(path, "")` to proper `unlink()` in `file-store.ts` and `version-store.ts`
  - Tasks and version history are now properly deleted when archived or removed
- **Browser Command**: Fixed browser opening on non-Bun runtimes with proper `spawn()` fallback
- **Server Path Detection**: Fixed `import.meta.dir` undefined error when running with Node.js
  - Now uses `fileURLToPath(import.meta.url)` as fallback for Node.js compatibility
  - Added Windows path separator support
- **Windows Build**: Fixed shebang syntax error when running built CLI on Windows
  - Build script now strips BOM and old shebangs before adding Node.js shebang
  - Added `.npmrc` with `legacy-peer-deps=true` for React 19 compatibility
- **Web UI Doc Update**: Fixed "path must be string" error when updating docs
  - Express 5 wildcard `{*path}` returns array, now properly joined to string

### Changed
- **Server Architecture**: Complete rewrite of `src/server/index.ts`
  - Replaced `Bun.serve()` with Express HTTP server
  - Replaced Bun WebSocket API with `ws` library
  - All 15 API routes migrated to Express router pattern
  - Static file serving now uses `express.static()`
- Refactored file operations across multiple modules to use the new compatibility layer:
  - `src/commands/task.ts` - Archive/unarchive operations
  - `src/commands/time.ts` - Time tracking data persistence
  - `src/storage/file-store.ts` - Task and project storage
  - `src/storage/version-store.ts` - Version history storage
- Simplified `src/utils/bun-compat.ts` - removed `serve()` function (now using Express)

## [0.1.7] - 2025-12-27

### Fixed
- **Web UI**: Fixed layout breaking with long parent task titles in dropdowns and displays
  - Truncated long titles in parent task selection dropdowns (TasksPage and TaskCreateForm)
  - Changed parent task display from button to div with proper accessibility attributes in TaskDetailModal
  - Added `w-full` constraint to prevent buttons from expanding to 1200px width
  - Implemented proper text truncation with `truncate`, `flex-1`, `min-w-0`, and `overflow-hidden` classes
  - Added title attributes to show full text on hover for truncated titles

## [0.1.6] - 2025-12-27

### Added
- **Real-time Sync**: CLI/AI changes now sync to Web UI in real-time via WebSocket
  - When AI or CLI modifies tasks/docs, Web UI updates automatically without refresh
  - Added `/api/notify` endpoint for CLI to notify server of changes
  - Tasks and docs pages listen for WebSocket updates
- **Custom Server Port**: Server port is now saved to config when using `-p` option
  - Example: `knowns browser -p 7000` saves port 7000 to config
  - Notify functions automatically use the saved port for real-time sync
- **Doc CLI**: Added `--folder` option to `doc create` command for creating docs in nested folders
  - Example: `knowns doc create "Guide" -f guides`
- **Doc CLI**: Added `--content` and `--append` options to `doc edit` command
  - `-c, --content <text>` - Replace document content
  - `-a, --append <text>` - Append to existing content
- **Web UI**: MDEditor now supports full-height mode for better editing experience
- **Web UI**: Create document modal is now larger (90vh) with full editor support
- **Documentation**: Added comprehensive CLI guide at `guides/knowns-cli-guide.md`

### Changed
- **Web UI**: Improved markdown editor layout with flex-based height management
- **Web UI**: Editor properly fills available space when editing docs
- **Reference System**: Doc mention regex now matches both `@doc/` and `@docs/` patterns

### Fixed
- **Web UI**: Fixed Assignee dropdown not working inside modal (Portal container fix)
- **Web UI**: Fixed editor scroll issues in full-height mode
- **Web UI**: Fixed create modal form fields not properly sized

## [0.1.5] - 2024-12-26

### Fixed
- **Kanban Board**: Fixed an issue where columns with many tasks were not scrollable. The entire board area is now vertically scrollable.

### Added
- **Build Process**: The UI now dynamically displays the version from `package.json`.
  - The version is injected at build time, so it's always up-to-date.

### Changed
- The UI build process now uses a separate script (`scripts/build-ui.js`) for more robust version injection.

## [0.1.3] - 2024-12-26

### Fixed
- **Browser Command**: Fixed UI path detection when running from installed package
  - Server now correctly finds pre-built UI files in `dist/ui`
  - Works in both development mode (build on-the-fly) and production (serve pre-built)
  - Fixed package root detection for bundled code
- **GitHub Actions**: Fixed release creation permissions error
  - Updated permissions from `contents: read` to `contents: write`
  - Switched from deprecated `actions/create-release@v1` to `softprops/action-gh-release@v1`
  - Enhanced release notes with installation instructions

### Added
- **Build Process**: UI files now built and included in npm package
  - `dist/ui/index.html` - Main HTML file
  - `dist/ui/main.js` - Minified React application (533KB)
  - `dist/ui/main.css` - Compiled styles
  - `dist/ui/index.css` - Additional styles
- Separate build scripts for CLI and UI (`build:cli`, `build:ui`, `build:copy-html`)
- Production vs development mode for browser server

### Changed
- Browser command now serves pre-built UI instead of building on user's machine
- Improved error messages when UI files are not found
- Server logs now indicate whether using pre-built UI or development mode

## [0.1.2] - 2024-12-26

### Added
- New `src/constants/knowns-guidelines.ts` file containing system prompt as TypeScript constant
- Auto-sync of Knowns guidelines to AI instruction files during `knowns init`
- Third step in "Next steps" output: "Update AI instructions: knowns agents --update-instructions"

### Changed
- Refactored `agents` command to use bundled constant instead of reading from CLAUDE.md
- CLAUDE.md is now a target file (not source) - gets updated like other AI instruction files
- Exported `updateInstructionFile()` and `INSTRUCTION_FILES` from agents.ts for reusability
- System prompt now bundled into binary, eliminating file I/O during sync

### Improved
- Faster agent instruction updates (no file reads required)
- More reliable init process - new projects get AI instructions automatically
- Simplified architecture: single source of truth for guidelines in codebase

## [0.1.1] - 2024-12-26

### Added
- GitHub Actions CI workflow for automated testing and linting
- GitHub Actions publish workflow for automated npm publishing
- Comprehensive badges in README (npm version, downloads, CI status, license, bundle size)
- Publishing guide documentation (.github/PUBLISHING.md)
- CHANGELOG.md to track version history

### Changed
- Updated repository URLs from placeholder to knowns-dev/knowns
- Enhanced README with more professional badges and links

### Fixed
- Repository and homepage URLs in package.json now point to correct GitHub organization

## [0.1.0] - 2024-12-26

### Added
- Initial release of Knowns CLI
- Task management with acceptance criteria
- Documentation management with nested folder support
- Context linking between tasks and documentation
- Time tracking built into tasks
- Search functionality across tasks and docs
- Web UI with Kanban board and document browser
- MCP (Model Context Protocol) server for AI integration
- Agent instruction sync (Claude, Gemini, Copilot)
- `--plain` flag for AI-readable output
- Multi-line input support for descriptions, plans, and notes
- Task workflow with plan, implementation notes, and status tracking
- Commands:
  - `knowns init` - Initialize project
  - `knowns task` - Task management commands
  - `knowns doc` - Documentation commands
  - `knowns search` - Global search
  - `knowns browser` - Web UI
  - `knowns agents` - Agent instruction sync
  - `knowns time` - Time tracking
  - `knowns mcp` - MCP server

### Documentation
- Comprehensive README with usage examples
- CLAUDE.md with complete guidelines for AI agents
- Example workflows and patterns

[0.3.1]: https://github.com/knowns-dev/knowns/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/knowns-dev/knowns/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/knowns-dev/knowns/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/knowns-dev/knowns/compare/v0.1.8...v0.2.0
[0.1.8]: https://github.com/knowns-dev/knowns/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/knowns-dev/knowns/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/knowns-dev/knowns/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/knowns-dev/knowns/compare/v0.1.3...v0.1.5
[0.1.3]: https://github.com/knowns-dev/knowns/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/knowns-dev/knowns/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/knowns-dev/knowns/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/knowns-dev/knowns/releases/tag/v0.1.0
