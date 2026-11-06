---
id: doc-c7fa6001bb3f09e82bbe7bee026cdcf5
title: Unified Runtime Adapter Install
description: Specification for global runtime adapter install and thin native hook/plugin setup across Claude Code, Codex, Kiro, and OpenCode.
createdAt: '2026-04-11T19:36:42.435Z'
updatedAt: '2026-04-11T19:49:16.730Z'
tags:
  - spec
  - approved
  - runtime
  - hooks
  - plugins
  - install
---

# Unified Runtime Adapter Install

## Overview

Define a global-only installation flow in `knowns` that installs thin runtime adapters for memory injection across `claude-code`, `codex`, `kiro`, and `opencode`.

This spec covers adapter installation, runtime discovery during init, file layout, config ownership, status reporting, and uninstall behavior. It does **not** redefine memory retrieval or ranking logic. That behavior remains owned by @doc/specs/runtime-memory-hook-injection.

The goal is to let users enable runtime memory injection from a single `knowns` command without publishing packages to npm and without duplicating memory logic inside each runtime integration.

## Locked Decisions

- D1: MVP install scope is global only. Adapters are installed into user-level runtime locations and apply across repositories.
- D2: MVP runtimes are `claude-code`, `codex`, `kiro`, and `opencode`.
- D3: `knowns` writes directly to runtime home config and hook/plugin paths during install. It does not require a separate manual apply step.
- D4: Runtime adapters remain thin. They invoke `knowns runtime-memory hook ...` and do not implement retrieval, ranking, or memory formatting themselves.
- D5: Runtime classification is explicit and must remain visible in UX and docs: `claude-code`, `codex`, and `kiro` use native hooks; `opencode` uses a plugin.
- D6: `knowns init` is allowed to discover available runtimes, let the user choose which ones should get memory injection, and trigger install from that selection flow.
- D7: OpenCode detection is installation-aware: if `opencode` is callable it should appear as available and selectable in the platform picker; if it is not installed and the user selects it, Knowns should automatically install OpenCode and then continue adapter setup.
- D8: In the `AI platforms to integrate` picker, each option should summarize the artifacts or config it creates in the same style as the existing platform list, and the supporting text should explain what runtime hook or plugin integration will be installed.

## Requirements

### Functional Requirements

- FR-1: `knowns` must provide a single install entrypoint for runtime adapters.
- FR-2: The install flow must support the runtimes `claude-code`, `codex`, `kiro`, and `opencode`.
- FR-3: `knowns` must install global adapter files into the runtime-specific user paths required by each runtime.
- FR-4: For `claude-code`, `codex`, and `kiro`, `knowns` must install native hook configuration plus any thin helper scripts required to invoke `knowns runtime-memory hook`.
- FR-5: For `opencode`, `knowns` must install a thin local plugin into the global OpenCode plugin/config location.
- FR-6: Installed adapters must call back into `knowns runtime-memory hook --runtime <runtime> --event <event>` or an equivalent stable subcommand.
- FR-7: The initial MVP must support pre-message memory injection only. Post-tool and post-turn events may be scaffolded or reserved, but must not be required for MVP correctness.
- FR-8: `knowns` must expose a status command that reports whether each supported runtime is installed, missing, misconfigured, or drifted.
- FR-9: `knowns` must expose an uninstall flow that removes files it installed without deleting unrelated user-owned runtime configuration.
- FR-10: `knowns` must record enough installation metadata to distinguish files it owns from files owned by the user or other tools.
- FR-11: When an existing runtime config file already contains unrelated user settings, `knowns` must merge or append only its managed section instead of overwriting the entire file.
- FR-12: If a runtime install path or config format is unsupported on the current machine, `knowns` must fail with a runtime-specific explanation and leave existing files unchanged.
- FR-13: `knowns` must present native-hook runtimes and plugin runtimes distinctly in CLI help, status output, and docs.
- FR-14: The install flow must not require publishing any package to npm.
- FR-15: The installed adapter artifacts should be self-contained and must not require additional package dependencies for the inject-only MVP.
- FR-16: `knowns init` must discover which supported runtimes are currently available on the machine and present them as selectable memory-hook targets.
- FR-17: `knowns init` must show clearly which CLI runtimes already have Knowns memory hooks installed, which are available but not yet configured, and which are unavailable.
- FR-18: If `opencode` is callable during `knowns init`, the init flow should treat it as available and show it in the existing `AI platforms to integrate` checklist as a normal selectable entry.
- FR-19: If `opencode` is not callable during `knowns init`, the default state should be not available; however, if the user explicitly selects OpenCode for memory hooks, Knowns must automatically install OpenCode first and then install the Knowns-managed plugin adapter.
- FR-20: Init output should be concise and should avoid presenting OpenCode setup as a separate complex workflow when a direct call/install path is available.
- FR-21: Status output must identify exactly which supported CLI tools currently have memory-hook integration installed.
- FR-22: In the `AI platforms to integrate` picker, each selectable runtime entry must describe what Knowns will install or configure when that option is selected.
- FR-23: The primary option label should include a concise artifact summary in the existing picker style, for example `Claude Code (CLAUDE.md, hooks, ...)` or `OpenCode (plugin, config, ...)`.
- FR-24: OpenCode may include an availability hint such as `Available` when `opencode` is in `PATH`, but the option must still read like an install/config target rather than a pure state indicator.
- FR-25: If OpenCode is not currently installed but the product allows auto-install on selection, the picker description should make that behavior explicit, for example by indicating that selecting OpenCode will install OpenCode and then add the Knowns plugin.

### Non-Functional Requirements

- NFR-1: Install and uninstall must be idempotent. Re-running them should converge to the same managed state.
- NFR-2: Install must preserve unrelated user configuration in runtime config files.
- NFR-3: Adapter invocation overhead for inject-only MVP should remain minimal and bounded to one `knowns` subprocess per hooked turn.
- NFR-4: Runtime-specific adapter files must stay small, readable, and easy to regenerate from `knowns`.
- NFR-5: The design must allow future extension to project scope without changing the core runtime-memory contract.
- NFR-6: Runtime discovery in `knowns init` must degrade safely when a CLI binary cannot be detected; missing runtimes should not block setup of other selected runtimes.

## Acceptance Criteria

- [ ] AC-1: A user can run one `knowns` install command per supported runtime and have the correct global native hook or plugin artifacts written automatically.
- [ ] AC-2: Installed adapters for `claude-code`, `codex`, and `kiro` use native hook mechanisms, while `opencode` uses a plugin mechanism, and this distinction is visible in status output.
- [ ] AC-3: The installed adapter for each runtime invokes `knowns runtime-memory hook` for pre-message injection without embedding its own retrieval or ranking logic.
- [ ] AC-4: Re-running install for an already installed runtime updates managed files safely without duplicating entries or deleting unrelated config.
- [ ] AC-5: Re-running uninstall removes only `knowns`-managed artifacts and leaves unrelated runtime settings intact.
- [ ] AC-6: `knowns runtime status` reports installed, missing, or drifted state for all four MVP runtimes.
- [ ] AC-7: No npm publication or external adapter dependency is required for the inject-only MVP.
- [ ] AC-8: `knowns init` shows which supported CLI tools already have memory hooks installed, which are available but not configured, and which are unavailable.
- [ ] AC-9: When `opencode` is missing but selected during `knowns init`, Knowns automatically installs OpenCode and then completes plugin setup without requiring a separate manual install step.
- [ ] AC-10: In the `AI platforms to integrate` picker, each selectable runtime explains what choosing it will install or configure, with an inline artifact summary in the option label.

## Scenarios

### Scenario 1: Install Codex native hook globally
**Given** Codex is available on the machine and no Knowns-managed Codex hook is installed
**When** the user runs the `knowns` install flow for `codex`
**Then** Knowns writes the required global hook config and helper artifacts into Codex's user-level paths
**And** the installed hook invokes `knowns runtime-memory hook --runtime codex --event user-prompt-submit`
**And** unrelated Codex configuration remains unchanged

### Scenario 2: Install OpenCode plugin globally
**Given** OpenCode is available on the machine and no Knowns-managed plugin is installed
**When** the user runs the `knowns` install flow for `opencode`
**Then** Knowns writes a thin plugin artifact into OpenCode's global plugin location
**And** the plugin delegates injection behavior to `knowns runtime-memory hook`
**And** no npm package publication is required

### Scenario 3: Reinstall over existing managed files
**Given** a runtime already has a Knowns-managed adapter installed
**When** the user runs install again for that runtime
**Then** Knowns updates or rewrites only the managed adapter files
**And** the final configuration remains valid and non-duplicated

### Scenario 4: Existing user config present
**Given** a runtime config file already contains user-managed settings unrelated to Knowns
**When** Knowns installs or updates its adapter
**Then** the user-managed settings remain intact
**And** only the Knowns-managed section is added or updated

### Scenario 5: Uninstall after global install
**Given** a runtime has a Knowns-managed adapter installed alongside unrelated user settings
**When** the user runs uninstall for that runtime
**Then** only Knowns-managed files or config sections are removed
**And** unrelated user settings remain intact

### Scenario 6: Unsupported runtime path or platform detail
**Given** a runtime's expected global config path cannot be resolved or is unsupported
**When** the user runs install
**Then** Knowns exits with a runtime-specific failure message
**And** it makes no partial destructive changes to existing files

### Scenario 7: Init shows runtime hook coverage
**Given** the machine has some supported CLIs installed and some missing
**When** the user runs `knowns init`
**Then** Knowns shows which supported CLIs already have memory hooks installed
**And** it shows which supported CLIs are available but not configured
**And** it shows which supported CLIs are unavailable

### Scenario 8: Init auto-installs missing OpenCode when selected
**Given** `opencode` is not callable on the machine
**And** the user selects OpenCode as a target during `knowns init`
**When** init proceeds with runtime setup
**Then** Knowns installs OpenCode automatically
**And** then installs the Knowns-managed OpenCode plugin adapter
**And** the final init result shows OpenCode as installed with memory hooks enabled

### Scenario 9: Picker explains what selecting Claude Code or OpenCode will do
**Given** the user is in the `AI platforms to integrate` picker during `knowns init`
**When** Claude Code or OpenCode is rendered as a selectable option
**Then** the option label contains a concise artifact summary such as `Claude Code (CLAUDE.md, hooks, ...)`
**And** the supporting text describes what selecting it will install or configure

## Technical Notes

### Relationship To Existing Memory Injection Spec

- Adapter installation and runtime file ownership are defined here.
- Memory selection, ranking, formatting, and bounded injection policy remain defined by @doc/specs/runtime-memory-hook-injection.
- The adapter contract should be stable enough that new runtimes can be added later without changing the core builder logic.

### Proposed CLI Surface

```text
knowns runtime install <runtime>
knowns runtime uninstall <runtime>
knowns runtime status
knowns runtime-memory hook --runtime <runtime> --event <event>
```

Init may also invoke the same install logic internally after runtime discovery and selection.

### Runtime Classification

- Native hook runtimes: `claude-code`, `codex`, `kiro`
- Plugin runtime: `opencode`

This classification is product behavior, not an implementation detail, and must remain explicit in install/status UX.

### Ownership Model

- Knowns-managed files or config blocks should be marked clearly so status and uninstall can identify them.
- If a runtime uses a shared JSON/TOML config file, Knowns should write a distinct managed section rather than replacing the whole document.
- If a runtime requires helper scripts, those scripts should be installed as Knowns-managed global artifacts near the runtime's expected hook/plugin config path or in a dedicated Knowns runtime adapter directory referenced by that config.

### Init UX Expectations

- Init should summarize supported runtimes in the existing `AI platforms to integrate` checklist-style view.
- Each runtime entry should primarily describe what Knowns will generate, install, or configure when selected.
- The option label should keep the existing picker pattern by summarizing main artifacts inline, for example `Claude Code (CLAUDE.md, hooks, ...)`.
- Availability may appear in the label when useful, for example `OpenCode (Available, plugin, config, ...)`, but full install state and memory-hook state should not be encoded into every picker option.
- OpenCode should be presented compactly: if callable, treat it like a normal selectable runtime; if missing and selected, install it automatically rather than branching into a separate verbose setup path.

Example shape:

```text
┃ AI platforms to integrate
┃ Choose which platforms to generate config and instruction files for.
┃ At least one platform must be selected.
┃ > [•] Claude Code (CLAUDE.md, hooks, ...)
┃     Installs global native memory hooks for Claude Code
┃   [•] OpenCode (Available, plugin, config, ...)
┃     Installs global OpenCode memory plugin
┃   [•] Kiro IDE (.kiro/steering, hooks, ...)
┃     Installs global native memory hooks for Kiro
```

### Future Extensions

The following are intentionally out of MVP scope but should not be blocked by the design:
- Project-scoped install
- Post-tool memory updates
- Post-turn summarization hooks
- Runtime-specific debug/inspect subcommands
- Additional runtimes such as Gemini CLI or Qwen CLI

## Open Questions

- [ ] What exact install paths and config merge strategies should be treated as canonical for each supported runtime implementation?
- [ ] Should `knowns runtime install all` be part of MVP or follow after per-runtime install is stable?
- [ ] Should drift detection compare exact generated contents, managed markers only, or both?
