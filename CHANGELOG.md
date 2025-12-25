# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.3]: https://github.com/knowns-dev/knowns/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/knowns-dev/knowns/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/knowns-dev/knowns/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/knowns-dev/knowns/releases/tag/v0.1.0
