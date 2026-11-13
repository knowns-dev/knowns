---
id: doc-30d3a68f5510706a754eab0b7f68c630
title: AI Permission Model
description: Research note on introducing a capability-based permission model for AI actions in Knowns.
createdAt: '2026-04-22T08:56:30.398Z'
updatedAt: '2026-04-22T08:56:30.398Z'
tags:
  - research
  - permissions
  - security
  - ai
  - mcp
---

# AI Permission Model

## Summary

This document outlines a direction for giving Knowns a clearer permission model for AI actions.

The goal is to move from scattered safety behaviors toward a consistent capability layer that defines what an AI session is allowed to read, write, generate, archive, or delete.

## Why This Matters

As Knowns grows into a richer AI-facing workspace, safety needs to become more explicit.

Even before advanced execution or hosted workflows, it is important to answer questions like:

- is this AI session read-only or writable
- can it update tasks but not delete them
- can it attach a plan but not publish a doc
- can it run template generation only as dry-run
- can it generate files without overwriting existing files

These are product-level behaviors, not just implementation details.

## Current State

Knowns already has several good safety primitives:

- some destructive MCP operations default to dry-run preview
- imported docs are treated as read-only in the browser UI
- tasks can be archived instead of only deleted
- some generation and sync paths distinguish between preview and overwrite behavior

These are valuable, but they are still distributed safeguards rather than one coherent permission system.

## Main Gap

There is no single policy model that says what an AI client is allowed to do in a project.

That means:

- enforcement is inconsistent across surfaces
- users cannot inspect one clear session policy
- future auditing and governance will be harder
- AI capabilities are harder to summarize in status/readiness views

## Direction

Knowns should move toward a capability-based permission model.

The key idea is that each AI-exposed action should be described in terms of:

- capability type
- target type
- risk level

That gives Knowns a shared language for policy, audit, readiness, and UI explanations.

## Useful Capability Categories

A practical first version could center on:

- read
- write
- generate
- archive
- delete
- admin

These are simple enough to explain to users and strong enough to cover most current AI-facing actions.

## Useful Target Categories

Targets should stay concrete and product-facing:

- task
- doc
- memory
- template
- import
- runtime
- code
- graph

That makes it easier to say things like:

- this session can update tasks and memories
- this session cannot delete docs
- this session can run templates only in preview mode

## Good Default Modes

A small number of preset modes would cover most needs well:

- read-only
- read-write
- read-write-no-delete
- generate-preview-only

The value of presets is clarity. Most users do not want to design a policy language before using the product.

## Enforcement Principle

The same policy should apply across all AI-facing surfaces.

That includes:

- MCP tools
- browser-mediated AI actions
- runtime-triggered automation
- future hub or hosted flows

If the policy model is different in each surface, users will not trust it.

## UX Principle

Permissions should be inspectable.

A user should be able to see, at session or project level:

- what this AI is allowed to do
- what it is not allowed to do
- which actions require preview or confirmation
- why a denied action was blocked

This should tie naturally into readiness and audit surfaces.

## Important Special Cases

Some areas deserve stricter handling from the start:

- imported docs and imported content
- destructive operations
- overwrite behavior for generation
- project or runtime switching operations

These are higher-risk actions and should not quietly inherit the same permissions as normal reads or standard updates.

## Suggested Sequence

1. Classify AI-facing actions by capability, target, and risk.
2. Add a shared policy checker.
3. Support a few clear preset modes.
4. Surface active policy in status and session views.
5. Connect policy outcomes to audit trails.

## What Success Looks Like

A user should be able to say:

- this AI can research and update tasks
- it cannot delete docs
- template generation is preview-only

And Knowns should be able to enforce that consistently, explain it clearly, and record it reliably.
