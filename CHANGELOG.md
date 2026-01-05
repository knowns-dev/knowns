# Changelog

All notable changes to Knowns will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-01-06

### Added

- **Git Tracking Mode**: Select tracking mode during `knowns init`
  - `git-tracked` (default): All `.knowns/` files tracked in git (recommended for teams)
  - `git-ignored`: Only docs tracked, tasks/config ignored (personal use)
  - Automatically updates `.gitignore` for git-ignored mode
- **SSE Auto-Reconnection**: Web UI automatically refreshes data on reconnect
  - Detects when connection is restored after sleep/wake
  - Triggers `tasks:refresh`, `time:refresh`, `docs:refresh` events
- **New Docs**: Added feature documentation
  - `features/git-tracking-modes.md` - Git tracking modes explained
  - `features/real-time-sync.md` - SSE sync and reconnection behavior

### Changed

- **WebSocket → SSE**: Migrated real-time updates from WebSocket to Server-Sent Events
  - Simpler protocol with built-in auto-reconnect
  - Better firewall compatibility (standard HTTP)
- **Init requires Git**: `knowns init` now checks for `.git` directory and exits with helpful message if not found
- **Documentation Updates**:
  - All docs translated to English
  - Updated architecture diagrams (WebSocket → SSE)
  - Added `--plain` flag clarification (only for view/list/search commands)
  - Added doc organization guide (core docs at root, categorized in folders)

### Fixed

- **Guidelines clarity**: Updated CLI/MCP templates to clarify `--plain` flag usage
  - `--plain` only works with view/list/search commands
  - Create/edit commands do NOT support `--plain`

## [0.5.0] - 2025-01-04

### Added

- **BlockNote Rich Text Editor**: Replace markdown textarea with BlockNote WYSIWYG editor
  - Task description, implementation plan, and notes now use rich text
  - Docs page uses BlockNote for editing
- **Mentions System**: Reference tasks and docs with `@task-X` and `@doc/path`
  - Autocomplete suggestions when typing `@`
  - Clickable mention badges with live data (title, status)
  - Works in both BlockNoteEditor and MDRender
- **Error Boundary**: Gracefully handle BlockNote rendering errors

### Fixed

- **Mention serialization**: Correctly save mentions as `@task-X` format instead of display text
- **Mentions in tables**: Delete/replace operations now work for mentions inside table cells
- **Mentions in code blocks**: Preserve raw `@task-X`, `@doc/path` in code blocks and inline code
  - UI: BlockNoteEditor and MDRender skip mention rendering in code
  - CLI: `--plain` output keeps mentions raw inside code blocks

### Changed

- **Editor view mode**: Use MDRender for viewing, BlockNoteEditor for editing (better stability)
- **Mention badge styles**: Synchronized between MDRender and BlockNoteEditor
  - Task badges: green theme
  - Doc badges: blue theme

## [0.4.0] - 2025-12-31

### Added

- **Template System**: 2x2 matrix of guidelines (type × variant)
  - Types: `cli` (CLI commands) and `mcp` (MCP tools)
  - Variants: `general` (full ~15KB) and `gemini` (compact ~3KB)
- **`--gemini` flag**: Use compact Gemini variant for smaller context windows
  - `knowns agents sync --gemini`
  - `knowns agents --update-instructions --gemini`
- **Doc list path filter**: Filter docs by folder
  - `knowns doc list "guides/" --plain`
  - `knowns doc list "patterns/" --plain`
- **Doc list tree format**: Token-efficient tree view with `--plain`

### Changed

- Restructured templates folder: `src/templates/{cli,mcp}/{general,gemini}.md`
- Interactive `knowns agents` now prompts for type and variant
- `knowns agents sync` supports `--type`, `--gemini`, `--all` options

### Fixed

- **`--plain` flag not working**: Fixed Commander.js option inheritance for nested commands
  - Added `.enablePositionalOptions()` and `.passThroughOptions()` to parent commands
  - Affects: `knowns task list --plain`, `knowns doc list --plain`, `knowns agents sync --gemini`

## [0.3.1] - 2025-12-31

### Fixed

- Clear error message when server port is already in use

## [0.3.0] - 2025-12-29

### Added

- Atomic Design UI refactoring (atoms, molecules, organisms, templates)
- CLI enhancements for AI agents
- File-based content options (`--content-file`, `--append-file`)
- Text manipulation commands (`doc search-in`, `doc replace`, `doc replace-section`)
- Validate & repair commands for tasks and docs
- `knowns agents sync` command

### Changed

- UI components reorganized following Atomic Design principles
- Improved shadcn/ui integration

## [0.2.0] - 2025-12-28

### Added

- Comprehensive documentation
- Improved README with quick start guide

## [0.1.8] - 2025-12-27

### Added

- Bun compatibility layer
- Full Node.js support for server, build, and tests

### Fixed

- File deletion issues
