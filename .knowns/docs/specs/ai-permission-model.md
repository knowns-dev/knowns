---
id: doc-955d0daf23fc2f9b748aa6faa4c91f43
title: AI Permission Model
description: Draft specification for a capability-based permission model for AI actions across MCP, browser, runtime, and future platform flows.
createdAt: '2026-04-23T07:57:37.028Z'
updatedAt: '2026-04-23T07:57:37.028Z'
tags:
  - spec
  - approved
  - permissions
  - security
  - mcp
  - runtime
  - ai
---

# AI Permission Model

## Overview

Define a capability-based permission model for AI actions in Knowns so projects can control what an AI client is allowed to read, write, generate, archive, or delete.

The goal is to move from scattered safety checks toward a consistent capability model that works across MCP, browser-mediated actions, runtime automation, and future hub workflows.

## Locked Decisions

- D1: Policy 2 tầng — project config đặt default policy, MCP session có thể override nhưng không vượt quá quyền project-level cho phép (ceiling model).
- D2: Default policy khi chưa cấu hình là `read-write-no-delete` — cấm delete hoàn toàn, read/write/generate hoạt động bình thường, dryRun giữ nguyên hành vi hiện tại.
- D3: Enforcement ở mức tool + action + entity attribute. Phase 1 implement tool+action level, model/schema thiết kế sẵn cho attribute conditions.
- D4: Two-pass enforcement — Pass 1 check capability+target (không cần IO), Pass 2 load entity rồi check attribute rules. Deny sớm ở Pass 1 tiết kiệm IO.
- D5: Nâng cấp `actionClassMap` trong `audit.go` thành shared registry (capability + target + risk level). Cả audit và permission consume từ registry này. Audit dùng field capability (tương thích ngược), permission dùng cả 3 fields.
- D6: Denial trả structured error: `denied`, `capability`, `target`, `reason`, `suggestion` (nếu có alternative), `policyRef` trỏ đến policy đang active.
- D7: Denied attempts ghi vào audit trail với result status `"denied"`, bao gồm đầy đủ context.

## Problem

Knowns already contains useful safety patterns:

- some destructive MCP tools default to dry-run preview
- imported docs are treated as read-only in the UI
- tasks can be archived instead of only deleted
- generated files and sync flows already differentiate between safe and overwrite behaviors in some paths
- `audit.go` already classifies every tool+action via `actionClassMap`

But these protections are currently local behaviors, not a unified permission system. There is no central policy model answering questions like:

- can this AI session read only, or also write
- can it create and update tasks but not delete them
- can it attach plans but not publish docs
- can it run templates only in dry-run mode
- can it generate files but not overwrite existing files

## Goals

- Introduce a capability-based permission model for AI actions.
- Make permissions inspectable, enforceable, and reusable across surfaces.
- Separate low-risk read actions from higher-risk write and destructive actions.
- Enable safe defaults for local-first and future hosted flows.
- Reuse existing `actionClassMap` infrastructure as the single source of truth for action classification.

## Non-Goals

- Add account-level authentication or multi-tenant billing in the first rollout.
- Replace existing runtime-specific permission prompts immediately.
- Enforce file-level operating system sandboxing inside Knowns itself.
- Implement attribute-based rules in Phase 1 (schema supports it, enforcement deferred to Phase 2).

## Requirements

### Functional Requirements

- FR-1: Every AI-exposed tool action must be classified by capability, target, and risk level via a shared registry that replaces the current `actionClassMap`.
- FR-2: Knowns must support permission presets: `read-only`, `read-write`, `read-write-no-delete`, `generate-dry-run`.
- FR-3: Project-level policy is stored in `config.json` under a `permissions` key. Session-level policy can override but cannot exceed project-level ceiling.
- FR-4: When no policy is configured, the implicit default is `read-write-no-delete`.
- FR-5: Policies must be enforceable across MCP tools and browser-mediated AI actions via a shared guard.
- FR-6: Policies must support per-capability restrictions such as allowing task updates while forbidding doc deletion.
- FR-7: Policies must support dry-run-only permissions for selected action classes such as template generation or destructive operations.
- FR-8: Imported or external content must be eligible for stricter default permissions than local project-owned content.
- FR-9: Denied actions must return structured error payloads containing: `denied`, `capability`, `target`, `reason`, `suggestion`, and `policyRef`.
- FR-10: Denied attempts must be recorded in the audit trail with result status `"denied"`.
- FR-11: The permission model schema must support attribute-based conditions (tag, assignee, content origin) for future Phase 2 enforcement.
- FR-12: Enforcement uses two-pass evaluation: Pass 1 checks capability+target (no IO), Pass 2 loads entity and checks attribute rules.

### Non-Functional Requirements

- NFR-1: The first rollout must not require complex user configuration to be safe (implicit default covers this).
- NFR-2: Permission metadata should be simple enough to show in UI and CLI summaries.
- NFR-3: The model must be forward-compatible with richer project, team, or hosted policies.
- NFR-4: Pass 1 capability check must add negligible latency (no IO, no entity loading).

## Capability Model

### Capability Classes

- `read`
- `write`
- `generate`
- `archive`
- `delete`
- `admin`

### Targets

- task
- doc
- memory
- template
- time
- import
- runtime
- graph
- search
- code

### Risk Levels

- low
- medium
- high

## Shared Action Registry

The current `actionClassMap` in `internal/mcp/audit.go` is upgraded to a shared registry. Each entry contains:

```go
type ActionMeta struct {
    Capability string // read, write, generate, delete, admin
    Target     string // task, doc, memory, template, time, search, code, runtime
    Risk       string // low, medium, high
}
```

The registry is the single source of truth consumed by both audit and permission systems.

### Full Classification

#### project

| Action | Capability | Target | Risk |
|--------|-----------|--------|------|
| `detect` | read | runtime | low |
| `current` | read | runtime | low |
| `set` | admin | runtime | medium |
| `status` | read | runtime | low |

#### tasks

| Action | Capability | Target | Risk |
|--------|-----------|--------|------|
| `create` | write | task | medium |
| `get` | read | task | low |
| `update` | write | task | medium |
| `delete` | delete | task | high |
| `list` | read | task | low |
| `history` | read | task | low |
| `board` | read | task | low |

#### docs

| Action | Capability | Target | Risk |
|--------|-----------|--------|------|
| `create` | write | doc | medium |
| `get` | read | doc | low |
| `update` | write | doc | medium |
| `delete` | delete | doc | high |
| `list` | read | doc | low |
| `history` | read | doc | low |

#### memory

| Action | Capability | Target | Risk |
|--------|-----------|--------|------|
| `add` | write | memory | medium |
| `get` | read | memory | low |
| `update` | write | memory | medium |
| `delete` | delete | memory | high |
| `list` | read | memory | low |
| `promote` | write | memory | medium |
| `demote` | write | memory | medium |

#### time

| Action | Capability | Target | Risk |
|--------|-----------|--------|------|
| `start` | write | time | low |
| `stop` | write | time | low |
| `add` | write | time | medium |
| `report` | read | time | low |

#### search

| Action | Capability | Target | Risk |
|--------|-----------|--------|------|
| `search` | read | search | low |
| `retrieve` | read | search | low |
| `resolve` | read | search | low |

#### code

| Action | Capability | Target | Risk |
|--------|-----------|--------|------|
| `search` | read | code | low |
| `symbols` | read | code | low |
| `deps` | read | code | low |
| `graph` | read | code | low |

#### templates

| Action | Capability | Target | Risk |
|--------|-----------|--------|------|
| `create` | write | template | medium |
| `get` | read | template | low |
| `list` | read | template | low |
| `run` | generate | template | medium |

#### validate

| Params | Capability | Target | Risk |
|--------|-----------|--------|------|
| default | read | runtime | low |
| `fix: true` | write | runtime | medium |

## Policy Model

### Policy Storage

```json
// config.json
{
  "permissions": {
    "preset": "read-write-no-delete",
    "rules": []
  }
}
```

### Preset Policies

| Preset | Allowed | Denied | Notes |
|--------|---------|--------|-------|
| `read-only` | read | write, generate, archive, delete, admin | |
| `read-write` | read, write, generate, archive | delete requires dryRun first | admin denied |
| `read-write-no-delete` | read, write, generate, archive | delete, admin | **Implicit default** |
| `generate-dry-run` | read, generate (dryRun=true only) | write, delete, admin | |

### Fine-Grained Rules (Phase 2 schema, Phase 1 ignored)

```json
{
  "rules": [
    {
      "capability": "delete",
      "target": "doc",
      "condition": { "tag": "imported" },
      "effect": "deny"
    },
    {
      "capability": "write",
      "target": "task",
      "condition": { "assignee": "$session.identity" },
      "effect": "allow"
    }
  ]
}
```

### Session Override

MCP session can request a policy via initialization params. The effective policy is the intersection of project ceiling and session request — session cannot escalate beyond project-level.

## Enforcement

### Two-Pass Evaluation

**Pass 1 — Capability Gate (no IO):**
1. Look up `ActionMeta` from shared registry using `tool.action` key.
2. Check if `meta.Capability` is allowed by effective policy preset.
3. If denied → return structured denial immediately, log to audit as `"denied"`.

**Pass 2 — Attribute Gate (requires entity, Phase 2):**
1. Load target entity.
2. Evaluate attribute-based rules against entity properties.
3. If denied → return structured denial, log to audit.

### MCP Integration

- Shared guard runs as `BeforeCallTool` hook, before the existing audit hook.
- Guard returns structured denial payload on deny.
- Audit hook records denied attempts with `result: "denied"`.

### Denial Payload

```json
{
  "denied": true,
  "capability": "delete",
  "target": "doc",
  "reason": "Policy 'read-write-no-delete' does not allow delete operations",
  "suggestion": "Use archive instead, or update project permissions in config.json",
  "policyRef": {
    "source": "project",
    "preset": "read-write-no-delete",
    "configPath": "config.json#permissions"
  }
}
```

## UX Direction

- Users can see the current policy via `project({ action: "status" })` readiness view.
- CLI: `knowns permissions` shows active policy summary.
- When an action is denied, the response explains capability, target, and which policy blocked it.
- `policyRef` tells the user exactly where to change the policy.

## Rollout Plan

### Phase 1

- Upgrade `actionClassMap` to shared `ActionMeta` registry with capability, target, risk.
- Implement preset policies and policy checker.
- Add `BeforeCallTool` permission guard on MCP.
- Store project policy in `config.json`.
- Default to `read-write-no-delete` when unconfigured.
- Return structured denial payloads.
- Record denied attempts in audit trail.

### Phase 2

- Add session-level policy override with ceiling enforcement.
- Implement attribute-based rule evaluation (Pass 2).
- Add imported-content restrictions and dry-run enforcement for generators.
- Surface active policy in browser UI and CLI.

### Phase 3

- Add policy inheritance for project, runtime, and future hosted scopes.
- Integrate policy outcomes with audit reporting and readiness views.
- Add policy management UI in browser.

## Acceptance Criteria

- [ ] AC-1: A shared `ActionMeta` registry classifies every tool+action by capability, target, and risk. Both audit and permission systems consume it.
- [ ] AC-2: Project-level policy is stored in `config.json` under `permissions` key with preset support.
- [ ] AC-3: When no policy is configured, the implicit default `read-write-no-delete` is enforced.
- [ ] AC-4: A `BeforeCallTool` guard evaluates Pass 1 (capability+target) and denies disallowed actions before handler execution.
- [ ] AC-5: Denied actions return structured error payloads with `denied`, `capability`, `target`, `reason`, `suggestion`, and `policyRef`.
- [ ] AC-6: Denied attempts are recorded in the audit trail with result status `"denied"`.
- [ ] AC-7: Template `run` and destructive `delete` actions can be limited to dry-run or denied entirely by policy.
- [ ] AC-8: Permission summaries are surfaced in `project status` readiness view.
- [ ] AC-9: The policy schema supports attribute-based conditions for Phase 2 without breaking changes.

## Scenarios

### Scenario 1: Default policy blocks delete

**Given** a project with no `permissions` configured in `config.json`
**When** an AI session calls `docs({ action: "delete", path: "specs/old-spec", dryRun: false })`
**Then** the guard denies the call with structured error containing `reason: "Policy 'read-write-no-delete' does not allow delete operations"` and `policyRef.preset: "read-write-no-delete"`, and audit logs the attempt with `result: "denied"`.

### Scenario 2: Configured policy allows delete

**Given** a project with `permissions.preset: "read-write"` in `config.json`
**When** an AI session calls `tasks({ action: "delete", taskId: "abc123", dryRun: false })`
**Then** the guard allows the call and the handler executes normally.

### Scenario 3: Read-only session

**Given** a project with `permissions.preset: "read-only"` in `config.json`
**When** an AI session calls `tasks({ action: "create", title: "New task" })`
**Then** the guard denies with `capability: "write"`, `reason: "Policy 'read-only' does not allow write operations"`.

### Scenario 4: Generate dry-run enforcement

**Given** a project with `permissions.preset: "generate-dry-run"` in `config.json`
**When** an AI session calls `templates({ action: "run", name: "component", dryRun: false })`
**Then** the guard denies with `reason: "Policy 'generate-dry-run' requires dryRun=true for generate operations"`.

### Scenario 5: Session cannot exceed project ceiling

**Given** a project with `permissions.preset: "read-write-no-delete"` in `config.json`
**When** an MCP session requests policy override to `"read-write"` (which allows delete)
**Then** the effective policy is the intersection: delete remains denied because project ceiling forbids it.

## Technical Notes

- The shared registry should live in a new package (e.g., `internal/permissions`) or be extracted from `internal/mcp/audit.go` into a shared location.
- `classifyAction()` in `audit.go` should be refactored to read from the new registry.
- The `BeforeCallTool` permission guard must run before the existing audit `BeforeCallTool` hook.
- Audit's `afterCallTool` should handle the new `"denied"` result status alongside `"success"` and `"error"`.

## Open Questions

- [ ] Should `archive` capability be modeled as separate from `delete`, or as a constrained form of `delete`?
- [ ] Should the `admin` capability (e.g., `project.set`) be controllable via policy, or always require explicit user action?
- [ ] For Phase 2 attribute rules, should condition expressions support basic operators (equals, contains, in) or a more expressive DSL?
