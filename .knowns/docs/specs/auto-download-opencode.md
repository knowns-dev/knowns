---
id: doc-728e857476dc2ef96c7bb00ae1771d6c
title: Auto-download OpenCode
description: Auto-detect and guide OpenCode installation when missing
createdAt: '2026-04-01T04:01:54.649Z'
updatedAt: '2026-08-19T10:04:29.586Z'
tags:
  - spec
  - superseded
---

# Auto-download OpenCode

## Overview

When a user runs `knowns serve`, the system should detect whether OpenCode is installed. If not, the web UI shows a warning and guides the user to install it. The `knowns init` command provides an interactive flow to install OpenCode using its official install methods.

## Locked Decisions

- D1: **Use official OpenCode install commands** — `curl -fsSL https://opencode.ai/install | bash` (macOS/Linux), `brew install anomalyco/tap/opencode` (macOS alternative), or `npm install -g opencode-ai` (Windows/fallback). Knowns does not manage its own copy of the binary. Only checks if `opencode` exists in PATH.
- D2: **Version range** — require minimum version (e.g. `>=1.3.0`). Accept any version above minimum. Show warning if version is too old or missing.
## Requirements

### Functional Requirements

#### Detection
- FR-1: On `knowns serve` startup, check if `opencode` binary exists in PATH via `exec.LookPath("opencode")`
- FR-2: If found, check version via `opencode --version` and compare against minimum required version
- FR-3: Store detection result in server state (available via API)

#### Browser Warning
- FR-4: When UI loads and OpenCode is not installed, show persistent warning banner: "OpenCode is not installed. AI chat will not work."
- FR-5: Warning includes install instructions and link to docs
- FR-6: Warning includes button/link to run `knowns init` instructions
- FR-7: When OpenCode is installed but version too old, show warning: "OpenCode version X.Y.Z is outdated. Requires >= {min_version}. Please update."
- FR-8: Warning dismissible but reappears on page reload if issue persists
- FR-9: API endpoint `GET /api/agent/status` returns `{ installed: bool, version: string, minVersion: string, compatible: bool }`
#### knowns init
- FR-10: `knowns init` checks OpenCode installation status
- FR-11: If not installed, prompt: "Which AI agent do you want to use?" → [OpenCode] [Skip]
- FR-12: If user selects OpenCode, detect OS/platform and suggest appropriate install command:
  - macOS/Linux: `curl -fsSL https://opencode.ai/install | bash`
  - macOS (alternative, if brew available): `brew install anomalyco/tap/opencode`
  - Windows: `npm install -g opencode-ai`
- FR-13: Ask user to confirm, then execute install command
- FR-14: After install, verify by running `opencode --version`
- FR-15: `knowns init --force` re-runs installation even if OpenCode already exists (useful for reinstall/upgrade)
- FR-16: If install command fails or verification fails, show error with manual install instructions and continue `knowns init` without blocking
#### Existing Behavior
- FR-17: If OpenCode is already installed and compatible, `knowns init` skips the install step (unless `--force`)
- FR-18: All other `knowns init` behavior (project setup, config, etc.) remains unchanged
- FR-19: `knowns serve` continues to work without OpenCode — only chat features are disabled

### Non-Functional Requirements

- NFR-1: Detection check completes in < 1 second (just PATH lookup + version check)
- NFR-2: Install command runs in user's shell with visible output (not hidden)
- NFR-3: No network calls from Knowns itself for installation — delegates to official install scripts

## Acceptance Criteria

- [ ] AC-1: `knowns serve` starts successfully whether OpenCode is installed or not
- [ ] AC-2: Browser shows warning banner when OpenCode is not in PATH
- [ ] AC-3: Browser shows version warning when OpenCode version < minimum required
- [ ] AC-4: No warning shown when OpenCode is installed and version is compatible
- [ ] AC-5: `GET /api/agent/status` returns correct installation status
- [ ] AC-6: `knowns init` prompts to install OpenCode when not found
- [ ] AC-7: `knowns init` suggests correct install command for current OS
- [ ] AC-8: `knowns init` verifies installation after install command completes
- [ ] AC-9: `knowns init --force` re-runs install even if already installed
- [ ] AC-10: Chat features gracefully disabled when OpenCode not available (no crash, clear message)
- [ ] AC-11: If install fails, show error message with manual install instructions and continue init without blocking

## Scenarios

### Scenario 1: Fresh install — no OpenCode
**Given** user has installed knowns-go but not OpenCode
**When** user runs `knowns serve` and opens browser
**Then** UI shows warning banner with install instructions, chat input disabled or shows message

### Scenario 2: knowns init installs OpenCode
**Given** OpenCode is not installed
**When** user runs `knowns init`
**Then** prompt asks if user wants to install OpenCode, user selects yes, install command runs, verification passes

### Scenario 3: OpenCode version too old
**Given** OpenCode v1.0.0 installed, minimum required is v1.3.0
**When** user runs `knowns serve`
**Then** UI shows version warning with upgrade instructions

### Scenario 4: Everything OK
**Given** OpenCode v1.5.0 installed, minimum required is v1.3.0
**When** user runs `knowns serve`
**Then** no warnings, chat fully functional

### Scenario 5: Force reinstall
**Given** OpenCode already installed
**When** user runs `knowns init --force`
**Then** install flow runs again (useful for upgrading or fixing broken install)

### Scenario 6: Install fails
**Given** OpenCode is not installed, no internet or brew not available
**When** user runs `knowns init` and selects OpenCode install
**Then** install command fails, error shown with manual install URL, init continues normally

## Technical Notes

### Detection Logic
```go
func detectOpenCode() (*AgentStatus, error) {
    path, err := exec.LookPath("opencode")
    if err != nil {
        return &AgentStatus{Installed: false}, nil
    }
    
    out, err := exec.Command(path, "--version").Output()
    if err != nil {
        return &AgentStatus{Installed: true, Version: "unknown"}, nil
    }
    
    version := parseVersion(string(out))
    compatible := semver.Compare(version, minVersion) >= 0
    
    return &AgentStatus{
        Installed:  true,
        Version:    version,
        MinVersion: minVersion,
        Compatible: compatible,
    }, nil
}
```

### Minimum Version
Define in @code/internal/agents/opencode/detect.go:
```go
const MinOpenCodeVersion = "1.3.0"
```

## Open Questions

- [x] OQ-1: ~~Nên auto-update OpenCode khi phát hiện version cũ không?~~ → Chỉ warning + hướng dẫn upgrade. Không auto-update vì risk break things và user không expect CLI tool tự update dependency.
- [x] OQ-2: ~~`knowns init --no-wizard` có nên auto-include opencode không?~~ → Không. `--no-wizard` dành cho CI/scripting, không cần interactive agent install.
## Audit Findings — Gaps to Address

### Must Fix (in this spec)

1. **Version checking missing** — daemon spawns any `opencode` in PATH without version validation. Spec already covers this (FR-2), but implementation must also gate daemon spawn on compatible version.

2. **Readiness probe** — `daemon.go:165` has hardcoded 2-second sleep after spawn. Replace with proper health check retry loop (poll `/global/health` every 500ms, timeout after 15s).

3. **`runtimeOpenCode` set when daemon fails** — `server.go:200-201` builds proxy even when daemon is nil. Should skip proxy setup when OpenCode unavailable.

4. **Init wizard feedback** — currently shows `"⚠ opencode not found"` but offers no action. Spec FR-11 through FR-14 address this with install prompt.

### Should Fix (related improvements)

5. **PID file is global** (`~/.knowns/opencode.pid`) — two projects running simultaneously will conflict. Consider per-project PID or shared daemon with project routing.

6. **Port derivation overflow** — `browserPort * 10` can exceed 65535 (e.g., port 7000 → 70000). Need bounds check before derivation.

7. **Health check timeouts hardcoded** — client uses 3s for health, 5s for requests. After fresh install, OpenCode may need longer startup. Make configurable or use longer initial timeout.

8. **Windows graceful shutdown** — `daemon_windows.go` uses `Kill()` not graceful SIGTERM. Consider `taskkill` for cleaner shutdown.

### Out of Scope (separate tasks)

9. **Uninstall/update path** — if we guide install, should we guide uninstall/update? Defer to native Go agent migration.

10. **`opencode.json` only has MCP config** — server settings live in `.knowns/config.json`. Config consolidation is a separate concern.


> **Superseded** by @decision/20260819-1703-remove-the-opencode-chat-ui - the OpenCode Chat UI was removed from Knowns.
