---
title: Priority Built-in LSP Expansion
description: Specification for adding Markdown, Bash, JSON/JSONC, Terraform/HCL, and YAML as capability-aware built-in LSP adapters
createdAt: '2026-07-20T14:45:24.386Z'
updatedAt: '2026-07-20T15:03:33.386Z'
tags:
  - spec
  - approved
  - lsp
  - code-intelligence
---

## Overview

Expand Knowns with five first-class built-in LSP adapters—Markdown, Bash, JSON/JSONC, Terraform/HCL, and YAML—while hardening language detection, runtime capability reporting, managed installation, and release verification. The adapters integrate through the existing shared LSP manager/daemon and remain compatible with the current CLI, MCP, API, and WebUI runtime surfaces.

This spec builds on @doc/specs/advanced-lsp-language-support and @doc/specs/lsp-runtime-wrapper-and-managed-backends. It defines the product and runtime contract for this priority wave; it does not reopen the full Phase 2 language roadmap.

## Locked Decisions

- D1: The scope is limited to Markdown, Bash, JSON/JSONC, Terraform/HCL, and YAML. Other Phase 2 languages are outside this spec.
- D2: All five adapters are built-in. Detection uses trustworthy file/project signals, and servers start lazily only when a code operation actually needs them.
- D3: Detection never downloads a server. Missing servers report `not_installed` with actionable `knowns lsp install <id>` guidance; WebUI install actions remain explicitly user initiated.
- D4: Each running server's advertised initialize capabilities are stored in a shared runtime snapshot. CLI, MCP, API, and WebUI consume the same snapshot. Unsupported actions return structured `unsupported_capability` responses without silent text-search fallback.
- D5: Code-language adapters require document symbols, definition, and references. Documentation/configuration adapters require document symbols and diagnostics. Rename, workspace symbols, and implementation are optional and must be reported accurately.
- D6: A server that starts but misses its required capability baseline is marked `degraded`. Supported actions remain usable, missing capabilities are listed, and pinned-version CI still fails when the required baseline is not met.
- D7: `.knowns/**` is excluded completely from these LSPs. Knowns-managed documents and configuration continue to use their domain MCP/tools.
- D8: Fixtures, testdata, generated directories, and vendored code do not trigger language auto-detection, but an explicit query for a specific file may still use the matching LSP.
- D9: File routing uses ordered path matchers rather than extension-only ownership. Terraform JSON forms take precedence over JSON; Bash shebang detection is supported; lock/generated JSON is excluded from automatic detection.
- D10: Each adapter must pass managed install and startup smoke tests on Linux, macOS, and Windows.
- D11: Each adapter fixture verifies startup plus every required baseline capability, shared capability status, and structured unsupported-action behavior.
- D12: Adapters may be released independently as soon as they pass the common quality gate. The spec is complete only after all five adapters pass.
- D13: `knowns lsp install <id>` installs a recommended version verified by Knowns CI. Users may choose `--latest` or `--version <tag>` after an explicit warning. The selected version, source, and integrity metadata are recorded.

## Requirements

### Functional Requirements

- FR-1: Register built-in adapters with stable IDs `markdown`, `bash`, `json`, `terraform`, and `yaml` through the existing shared adapter/runtime registry.
- FR-2: Use Marksman as the Markdown backend, `bash-language-server` as the Bash backend, VS Code JSON Language Server as the JSON/JSONC backend, `terraform-ls` as the Terraform/HCL backend, and `yaml-language-server` as the YAML backend.
- FR-3: Support `.md` and `.markdown` for Markdown. `.mdx` must not be claimed by the Markdown adapter.
- FR-4: Support `.sh`, `.bash`, and extensionless files with a Bash-compatible shebang for Bash.
- FR-5: Support `.json` and `.jsonc` for JSON, while excluding recognized lock/generated JSON files from automatic detection.
- FR-6: Support `.tf`, `.tfvars`, `.tf.json`, and `.tfvars.json` for Terraform. Terraform compound suffixes must route to Terraform before the general JSON matcher.
- FR-7: Support `.yaml` and `.yml` for YAML.
- FR-8: Exclude `.knowns`, VCS metadata, dependency/vendor directories, build output, generated output, fixtures, and testdata from automatic detection according to D7 and D8.
- FR-9: Detection may report an adapter as applicable or missing, but must not eagerly start the server. The first matching code operation starts the server through the shared daemon/session boundary.
- FR-10: A Markdown README alone must not eagerly start Marksman. A direct Markdown code request, `.marksman.toml`, or another configured/documentation project signal may make Markdown applicable.
- FR-11: Capture server-advertised capabilities after initialize and expose a normalized capability set for document symbols, workspace symbols, definition, references, rename, implementation, diagnostics, formatting, hover, completion, and document links.
- FR-12: Enforce the minimum capability profiles defined by D5 for runtime status and release verification.
- FR-13: Return a structured `unsupported_capability` result containing language ID, backend ID, requested action, advertised capabilities, and actionable explanation whenever a code action is unavailable.
- FR-14: Report `degraded` when a running server lacks a required baseline capability, while allowing supported actions to continue.
- FR-15: Display normalized capability and degraded-state data consistently in `knowns lsp list`, MCP `initial`, API responses, and WebUI LSP administration.
- FR-16: Keep installation user initiated. Missing-server guidance must identify the adapter, prerequisite, install command, and upstream source.
- FR-17: Provide managed npm installation for Bash, JSON, and YAML, and managed release-binary installation for Markdown and Terraform.
- FR-18: Default managed installation to the adapter's recommended known-good version. Support explicit `--latest` and `--version <tag>` selectors only after a warning and confirmation, with a non-interactive explicit-confirmation mechanism for CI.
- FR-19: Record installed version, requested selector, resolved version/tag, source URL or package, integrity/checksum, install time, and whether the version was verified by Knowns CI.
- FR-20: Preserve PATH-first resolution. A compatible user-installed binary may be selected, and its actual version and advertised capabilities must be reported.
- FR-21: Allow each adapter to be released independently when its quality gate passes without marking the overall spec complete until all five adapters pass.
- FR-22: Preserve existing built-in adapters and current code tool response shapes except for additive capability/degraded metadata and structured unsupported-capability errors.

### Non-Functional Requirements

- NFR-1: Starting an MCP session or project daemon must not eagerly start any of the five new servers solely because matching files exist.
- NFR-2: Managed installs must be reproducible and integrity checked. Known-good versions must use pinned exact versions and platform-appropriate checksums or package integrity metadata.
- NFR-3: Detection and routing must be deterministic across Linux, macOS, and Windows, including path separator and shebang handling.
- NFR-4: One missing, crashed, or degraded language server must not prevent other language servers from operating.
- NFR-5: Capability/status data exposed through CLI, MCP, API, and WebUI must originate from one shared runtime snapshot.
- NFR-6: Default test runs remain offline and deterministic; real external-server fixtures are explicitly gated and run in dedicated CI jobs.
- NFR-7: Existing projects without any of the five relevant file types must observe no additional language-server processes.

## Acceptance Criteria

- [ ] AC-1: `knowns lsp list` exposes all five built-in adapters with stable IDs, backend, install state, runtime state, and capability summary.
- [ ] AC-2: A project daemon with a README, JSON config, or YAML workflow starts none of the new servers until a matching code request occurs.
- [ ] AC-3: A direct request for a supported Markdown file lazily starts Marksman and returns document symbols plus link diagnostics.
- [ ] AC-4: Markdown files under `.knowns/**` are not detected or routed to Marksman.
- [ ] AC-5: A Bash script with `.sh`/`.bash` or a Bash-compatible shebang routes to Bash and passes symbols, definition, and references fixture checks.
- [ ] AC-6: JSON and JSONC files return document symbols and schema diagnostics through the JSON backend.
- [ ] AC-7: Lock/generated JSON files do not trigger JSON auto-detection.
- [ ] AC-8: `.tf.json` and `.tfvars.json` files route to Terraform rather than JSON.
- [ ] AC-9: Terraform fixtures pass symbols, definition, and references checks.
- [ ] AC-10: YAML/YML fixtures return document symbols and schema diagnostics.
- [ ] AC-11: Fixture/testdata/generated/vendor files do not trigger auto-detection but explicit file requests can route to the matching adapter unless the file is under `.knowns/**`.
- [ ] AC-12: Unsupported code actions return `unsupported_capability` with language, backend, action, advertised capabilities, and explanation; no implicit text fallback occurs.
- [ ] AC-13: A server missing a required baseline capability is shown as `degraded` consistently in CLI, MCP `initial`, API, and WebUI while supported actions remain callable.
- [ ] AC-14: `knowns lsp install <id>` installs the recommended known-good version without requiring a version argument.
- [ ] AC-15: `--latest` and `--version <tag>` show a warning and require explicit confirmation before installation.
- [ ] AC-16: Managed installation records resolved version, source, integrity/checksum, verification status, and install time.
- [ ] AC-17: PATH-installed compatible servers are selectable and report actual version and capabilities without being replaced automatically.
- [ ] AC-18: Each adapter passes managed install, startup, and required-capability smoke tests on Linux, macOS, and Windows.
- [ ] AC-19: An adapter can be released after its own quality gate passes even when another adapter in this spec remains incomplete.
- [ ] AC-20: Existing LSP adapter and code-tool tests remain passing, and the five new adapters do not change routing for existing extensions.

## Scenarios

### Scenario 1: Lazy Markdown navigation
**Given** a repository contains README and documentation Markdown files outside `.knowns`
**When** an agent requests symbols or definition for one of those files
**Then** Marksman starts lazily, returns supported results, and publishes its capability snapshot without starting during initial project activation.

### Scenario 2: Knowns-managed Markdown remains domain-owned
**Given** a Markdown document is stored under `.knowns/docs`
**When** language detection or a generic code lookup scans the repository
**Then** the Markdown adapter ignores the file and Knowns domain tools remain the only supported access path.

### Scenario 3: Bash shebang without extension
**Given** an executable file has no extension and begins with a Bash-compatible shebang
**When** an agent requests symbols or references
**Then** the file routes to the Bash adapter and the server starts lazily.

### Scenario 4: Terraform JSON precedence
**Given** a repository contains both `settings.json` and `network.tf.json`
**When** code operations target each file
**Then** `settings.json` routes to JSON and `network.tf.json` routes to Terraform.

### Scenario 5: Missing server
**Given** YAML files are applicable but `yaml-language-server` is absent
**When** a YAML code operation is requested
**Then** Knowns reports `not_installed` with prerequisites and `knowns lsp install yaml` without downloading automatically.

### Scenario 6: Runtime capability drift
**Given** a PATH-installed server starts but does not advertise a required baseline capability
**When** runtime status is read
**Then** the adapter is `degraded`, missing capabilities are visible everywhere, and supported actions continue to work.

### Scenario 7: Explicit latest installation
**Given** a recommended JSON server version exists
**When** a user requests `knowns lsp install json --latest`
**Then** Knowns shows a warning, requires explicit confirmation, resolves and records the selected version and integrity, and marks whether it was verified by Knowns CI.

### Scenario 8: Independent release
**Given** Markdown, Bash, JSON, and YAML pass all quality gates while Terraform still fails on Windows
**When** a release is prepared
**Then** the four passing adapters may ship and Terraform remains incomplete without blocking them or completing this spec.

## Technical Notes

- Replace extension-only routing with ordered path matchers while preserving existing registry behavior for simple extensions.
- Reuse the shared manager/daemon/session boundary, managed dependency lifecycle, plugin registry, runtime status snapshot, logs, and WebUI administration paths.
- Capability normalization should prefer the actual initialize response over static adapter claims; static declarations define expected baselines and known limitations.
- Recommended upstream distribution model: Marksman and `terraform-ls` release binaries; `bash-language-server`, VS Code JSON Language Server, and `yaml-language-server` npm packages.
- Real-server fixtures should use small deterministic repositories or local fixture projects and remain opt-in for default test runs.

## Task Links

- @task/c08i8z — Ordered routing and lazy detection foundation (AC-2, AC-11)
- @task/22kgy1 — Runtime capability contract and shared degraded status (AC-12, AC-13)
- @task/sei833 — Managed version selectors and install provenance (AC-14–AC-17)
- @task/ch33v4 — Built-in Markdown support with Marksman (AC-3, AC-4)
- @task/l3zxzn — Built-in Bash language-server support (AC-5)
- @task/697dha — Built-in JSON and JSONC language-server support (AC-6, AC-7)
- @task/aytry5 — Built-in Terraform and HCL support (AC-8, AC-9)
- @task/vdbu5a — Built-in YAML language-server support (AC-10)
- @task/4ebuzd — Adapter integration and cross-platform fixture CI (AC-1, AC-18–AC-20)

## Open Questions

- None. All scope and behavior decisions required for this draft are locked above.
