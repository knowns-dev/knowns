---
title: Runtime Memory Per Prompt Injection
description: Specification for selective per-prompt runtime Memory injection, bounded payload serialization, mode semantics, capture controls, and debug observability.
createdAt: '2026-06-18T08:58:45.261Z'
updatedAt: '2026-06-18T09:49:36.020Z'
tags:
  - spec
  - approved
---

## Overview

Improve runtime memory hooks so they provide useful, trusted Memory context at the moment a runtime needs it.

The existing runtime-memory hook can select relevant Memories and produce a bounded guidance payload, but the plain injected text mostly contains generic Knowns Guidance rather than the selected Memory facts. This feature turns the hook into a selective Memory injection layer: session-start still provides a small baseline, while prompt-aware runtime surfaces can request relevant active Memories for the current prompt.

The feature remains Memory-only for this phase. Decisions stay out of runtime hook payloads and can be covered by a separate spec later. Memory remains supplemental context only and never overrides `KNOWNS.md`, source-of-truth docs, tasks, or source files.

Related context:
- @doc/specs/runtime-memory-hook-injection
- @doc/specs/2026-06-18/memory-decision-review-ui
- @memory/6ews7l

## Locked Decisions

- D1: The spec covers the full runtime-memory hook improvement package: per-prompt retrieval, selected Memory serialization, `mode=off` enforcement, debug/skip observability, and capture controls.
- D2: Per-prompt retrieval is runtime-aware. Runtimes with safe prompt-level hook surfaces use per-prompt retrieval; runtimes without such surfaces keep session-start baseline while the shared CLI/builder remains prompt-ready.
- D3: Runtime payload uses compact Memory fact cards: `@memory/id`, layer/category, title, and one truncated content paragraph. Match metadata, score, and reasons appear only in debug output.
- D4: Per-prompt payloads use a small selective budget by default: at most 3 Memories and roughly 1200-1600 bytes. Session baseline may keep a larger budget.
- D5: `mode=debug` is inspect-only. It does not inject Memory into model context; it returns or logs selection metadata for debugging.
- D6: Auto-capture from runtime hooks has its own setting and controlled default. It may create `proposed` Memories only for high-confidence candidates and can be disabled independently from injection.
- D7: Skip and selection observability is exposed through JSON/debug output and optional runtime logs. Plain mode remains silent when there is no injection.
- D8: This phase is Memory-only. Runtime hook payloads include active Memories only; Decision injection is out of scope for this spec.

## Requirements

### Functional Requirements

- FR-1: The shared runtime memory builder must serialize selected Memories into bounded plain-text payloads when injection is allowed.
- FR-2: Per-prompt runtime events must use the current prompt as the retrieval query when the runtime exposes a safe prompt-level hook or adapter surface.
- FR-3: Session-start events must continue to provide a small baseline payload without requiring a prompt.
- FR-4: Auto-mode injection must include only Memories that are trusted for default retrieval, currently active Memories.
- FR-5: The compact payload must include each selected Memory reference, scope/category, title, and truncated content, without exposing score or ranking reasons in normal plain output.
- FR-6: `mode=off` must suppress both injection and auto-capture.
- FR-7: `mode=debug` must return inspectable selection details without injecting Memory into model context.
- FR-8: Runtime auto-capture must be controlled by a separate setting from injection mode.
- FR-9: Auto-captured hook Memories must remain `proposed` and must not participate in default retrieval or injection until reviewed and activated.
- FR-10: JSON/debug output must expose enough information to explain skip and selection decisions, including skip reason, selected item count, retrieval mode, and capture outcome.
- FR-11: Plain output must remain empty when no Memory should be injected.

### Non-Functional Requirements

- NFR-1: Per-prompt payloads must stay within the configured item and byte limits.
- NFR-2: Injection must be deterministic for the same store, prompt, mode, and settings.
- NFR-3: The hook must fail closed: unsupported runtime, missing project, mode off, low-signal prompts, and below-threshold candidates must not inject context.
- NFR-4: Runtime hook behavior must preserve the Memory lifecycle trust boundary introduced by @doc/specs/2026-06-18/memory-decision-review-ui.
- NFR-5: Debug observability must not leak into normal plain text payloads.

## Acceptance Criteria

- [x] AC-1: Given active relevant Memories and a prompt-level event, the hook outputs a bounded plain-text payload containing compact Memory fact cards.
- [x] AC-2: Given only proposed, archived, rejected, merged, or otherwise non-active Memories, auto-mode hook output contains no Memory fact cards.
- [x] AC-3: Given `mode=off`, the hook returns no plain payload and performs no auto-capture.
- [x] AC-4: Given `mode=debug`, JSON/debug output includes candidate items, ranking or skip metadata, and capture outcome, while normal injection is disabled.
- [x] AC-5: Given a low-signal prompt such as `ok` or `continue`, the hook emits no plain payload and reports `low_signal_prompt` in debug/JSON output.
- [x] AC-6: Given relevant Memories whose score is below injection threshold, the hook emits no plain payload and reports `below_threshold` in debug/JSON output.
- [x] AC-7: Given a runtime with a safe prompt-level surface, its installed hook or adapter calls the shared hook path with prompt context for per-prompt retrieval.
- [x] AC-8: Given a runtime without a safe prompt-level surface, its existing session-start baseline behavior remains functional.
- [x] AC-9: Given auto-capture disabled, prompt handling can still inject Memories but creates no proposed Memory.
- [x] AC-10: Given high-confidence auto-capture enabled, the hook creates at most a proposed Memory through the review path and never activates it automatically.
- [x] AC-11: Per-prompt payload tests prove max item and max byte limits are enforced after content truncation.
- [x] AC-12: Runtime install/status tests verify hook event wiring for runtimes changed by this spec.
## Scenarios

### Scenario 1: Prompt-level Memory injection

**Given** the project has active Memories about semantic search
**And** the user prompt is `toi muon tim hieu ve semantic search cua he thong`
**When** a prompt-level runtime hook runs in `auto` mode
**Then** the hook selects relevant active Memories
**And** the plain payload includes compact Memory fact cards within the per-prompt budget.

### Scenario 2: Session-start baseline remains small

**Given** a runtime starts a new session without a user prompt
**When** the session-start hook runs in `auto` mode
**Then** Knowns may inject only the baseline guidance and high-value baseline Memories
**And** the payload remains bounded separately from per-prompt defaults.

### Scenario 3: Proposed Memory is not trusted yet

**Given** a runtime hook auto-captured a proposed Memory from a prior prompt
**When** a later prompt would match that proposed Memory
**Then** auto-mode injection excludes it
**And** debug mode can show it as a non-active candidate for inspection.

### Scenario 4: Mode off disables all hook behavior

**Given** runtime memory mode is `off`
**When** any runtime hook event runs
**Then** the hook emits no payload
**And** it does not auto-capture prompt content.

### Scenario 5: Debug explains no injection

**Given** the user prompt is low signal or candidates do not pass threshold
**When** the hook runs in debug/JSON mode
**Then** the response includes a clear skip reason
**And** plain mode would remain silent for the same input.

### Scenario 6: Capture setting is independent

**Given** runtime Memory injection is enabled
**And** auto-capture is disabled
**When** a prompt contains a stable preference or project rule
**Then** the hook may inject relevant active Memories
**But** it creates no new proposed Memory.

## Technical Notes

- Existing entry points include `knowns runtime-memory hook`, `internal/runtimememory.Build`, `internal/runtimememory.Capture`, and runtime install wiring in `internal/runtimeinstall`.
- The selected Memory serialization should reuse the builder's existing item selection and byte-limit flow instead of adding a second retrieval path.
- Compact fact cards should keep normal payload text useful but short; debug output should carry scores, matchedBy, reasons, retrieval mode, and skip/capture details.
- Runtime-aware per-prompt support should change only adapters with safe hook surfaces in this phase; the shared builder should remain runtime-agnostic.
- This spec intentionally does not add Decision injection. If accepted Decisions should later appear in runtime prompts, create a separate spec that covers Decision trust, supersession, and prompt payload semantics.

## Task Links

Generated implementation tasks:

- @task/xovplj runtime-memory-per-prompt-injection-01 | Serialize selected Memories into bounded hook payload - done
- @task/vd7g5w runtime-memory-per-prompt-injection-02 | Enforce hook mode and injection eligibility semantics - done
- @task/5srhg3 runtime-memory-per-prompt-injection-03 | Add runtime Memory capture controls - done
- @task/ee7u76 runtime-memory-per-prompt-injection-04 | Wire runtime-aware per-prompt hook support - done
## Open Questions

- [ ] None.
