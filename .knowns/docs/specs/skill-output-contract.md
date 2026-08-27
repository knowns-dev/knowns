---
title: Skill Output Contract
description: Specification for a consistent output contract across all built-in skills
createdAt: '2026-03-13T10:07:47.595Z'
updatedAt: '2026-08-13T13:23:43.631Z'
tags:
  - spec
  - skills
  - ai
---

## Overview

Define a single output contract that all built-in skills must follow consistently when invoked through the CLI. The contract standardizes what each skill returns to the user so downstream workflow steps are predictable, reviewable, and easy to chain.

This spec only covers the skill instruction sources under `internal/instructions/skills/*`. Runtime auto-sync behavior for `.claude/skills/*` is explicitly out of scope.

## Requirements

### Functional Requirements

- FR-1: Define a shared output contract for built-in skills that specifies required response sections and ordering.
- FR-2: Apply the contract consistently across all built-in skill instruction sources in `internal/instructions/skills/*`.
- FR-3: Preserve each skill's domain-specific workflow while making its final user-facing output conform to the shared contract.
- FR-4: Distinguish between mandatory output elements and optional, skill-specific additions.
- FR-5: Document the next-step handoff each skill should provide when a natural follow-up action exists.

### Non-Functional Requirements

- NFR-1: The contract must be concise enough for CLI use and must not force verbose boilerplate.
- NFR-2: The contract must be understandable from the skill source alone without depending on sync-layer behavior.
- NFR-3: The contract must be testable via deterministic review of skill source content.

## Acceptance Criteria

- [ ] AC-1: A written output contract exists that defines the minimum required structure for skill responses, including goal/result, key details, and next action when applicable.
- [ ] AC-2: All built-in skill sources under `internal/instructions/skills/*/SKILL.md` are updated or confirmed to follow the same contract without introducing conflicting output rules.
- [ ] AC-3: The spec explicitly states that syncing or generation of `.claude/skills/*` is out of scope because runtime skill auto-sync already handles it.
- [ ] AC-4: The contract allows skill-specific content only as an extension of the shared structure, not as a replacement for it.
- [ ] AC-5: The affected skill list is explicitly identified so implementation and verification scope is unambiguous.
- [ ] AC-6: The contract defines what the user should see at the end of a successful skill workflow, including a recommended next command when one naturally exists.

## Scenarios

### Scenario 1: Run a planning-oriented skill
**Given** a user invokes a built-in skill such as `/kn-spec` or `/kn-plan`
**When** the skill completes its main workflow step
**Then** the response follows the shared contract and clearly tells the user what was produced and what to run next

### Scenario 2: Run a skill with domain-specific output
**Given** a user invokes a skill that needs specialized content such as research findings or verification results
**When** the skill returns its result
**Then** the specialized content appears inside the shared output structure instead of inventing a completely different response shape

### Scenario 3: Review implementation scope
**Given** an implementer reviews the spec
**When** they determine which files to update
**Then** they only modify sources in `internal/instructions/skills/*` and do not include sync mechanics for generated platform files

## Technical Notes

- Primary implementation surface: `internal/instructions/skills/*/SKILL.md`
- Skills in scope: every directory under `internal/instructions/skills/kn-*`. The canonical list is the shared roster sentence those files carry, which a contract test keeps in step with the embedded set. Do not maintain a second copy here.
- Verification can be done by reviewing each skill source for consistent final output guidance.

## Open Questions

- [ ] Should the contract require a fixed heading vocabulary, or only a fixed information order?
- [ ] Should every skill always provide a next command, or only when a clear workflow continuation exists?


## Contract Clarifications

The contract requires a fixed information order, not fixed heading vocabulary:

1. Goal/result
2. Key details
3. Next action only when a natural handoff exists

Implementation scope is every built-in skill, without exception. This document previously carried two hand-maintained lists that disagreed with each other and with the codebase; both were replaced by a pointer to the roster sentence in the skill sources, which is now test-enforced.

Portability requirements apply to the canonical sources under `internal/instructions/skills/*/SKILL.md`: workflow logic must not require a named external research provider or agent platform. Generated platform copies remain out of implementation scope because setup/sync overwrites them.

Research-specific contract:

- read-only by default
- persistence only with explicit authorization or an approved parent workflow
- external tools selected by capability and source quality
- official/primary evidence preferred and cited
- missing current-information capability reported explicitly instead of guessed around

Deterministic Go tests verify the embedded sources and representative synced copies while preserving approval, validation, task lifecycle, Spec Decision, System Decision, and verification gates.
