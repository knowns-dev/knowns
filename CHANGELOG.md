# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.7]: https://github.com/knowns-dev/knowns/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/knowns-dev/knowns/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/knowns-dev/knowns/compare/v0.1.3...v0.1.5
[0.1.3]: https://github.com/knowns-dev/knowns/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/knowns-dev/knowns/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/knowns-dev/knowns/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/knowns-dev/knowns/releases/tag/v0.1.0
