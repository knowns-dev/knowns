---
id: doc-2f8aeef761931182c58744ca89b48234
title: MCP Audit Trail And Tool Stats
description: Research note on structured MCP audit events, recent activity views, and aggregate tool usage statistics.
createdAt: '2026-04-22T08:56:30.406Z'
updatedAt: '2026-04-22T08:56:30.406Z'
tags:
  - research
  - mcp
  - audit
  - observability
  - usage
---

# MCP Audit Trail And Tool Stats

## Summary

This document describes a direction for adding structured audit and usage statistics for MCP activity in Knowns.

The basic idea is straightforward: each MCP tool call should leave behind a structured event that can be inspected, summarized, and eventually connected to policy and trust surfaces.

## Why This Matters

As soon as AI clients can do meaningful work through MCP, users need better visibility into what actually happened.

That includes simple but important questions:

- which MCP tools were called
- how often each tool is used
- which calls were reads versus writes
- which actions were preview-only versus real execution
- which calls failed or were denied
- which projects and clients generated the activity

This is valuable for trust, debugging, observability, and future governance.

## Current State

Knowns already has runtime and lifecycle information, and it already distinguishes some safer operations such as dry-run delete previews.

But it does not yet have a first-class structured audit trail for MCP tool calls.

That means low-level logs may exist, but they do not answer product questions well.

## Main Gap

There is currently no canonical history of AI tool actions that can be summarized for humans.

Without that layer, it is harder to:

- explain what the AI just did
- debug surprising behavior
- understand which tools are actually used in practice
- build meaningful permission reporting later

## Direction

Knowns should record MCP tool calls as structured events rather than relying only on transport or process logs.

Those events should be rich enough to answer product questions, but not so verbose that they leak full sensitive content by default.

## What To Record

A useful first event shape would capture:

- timestamp
- project scope
- tool name
- client or session when available
- action class such as read, write, delete, generate, or admin
- dry-run versus real execution
- success, error, or denial outcome
- duration
- target entity references when available

That is enough to support both recent activity views and aggregate stats.

## Privacy Principle

Audit should prefer summaries over raw payload capture.

For example:

- record doc path instead of full doc content
- record task ID instead of full task body
- record operation type or payload size instead of large free-form text where possible
- never treat secrets or raw credentials as normal audit payloads

This keeps the system useful without turning audit into a silent content archive.

## Stats Layer

Once structured events exist, Knowns can surface useful summaries such as:

- top tools by usage
- read versus write volume
- success versus error rate by tool
- dry-run versus execute counts
- recent writes and destructive attempts
- activity by project
- activity by client

These summaries are useful on their own even before more advanced policy work arrives.

## Product Value

An audit layer helps multiple parts of the product at once:

- users gain trust because actions are visible
- developers gain observability because tool usage becomes measurable
- support and debugging become easier because behavior is inspectable
- future permission work gains a factual event stream instead of assumptions

## Relationship To Permissions

Audit and permissions should remain separate concepts, but they reinforce each other.

Permissions answer:

- what was allowed
- what was denied

Audit answers:

- what was attempted
- what actually happened

Over time, these should connect so that users can see both policy and behavior in one coherent model.

## Suggested Sequence

1. Record one structured event per MCP tool call.
2. Add recent activity and basic stats views.
3. Add session and client attribution where available.
4. Connect audit with permission outcomes and high-risk action reporting.

## What Success Looks Like

A user should be able to inspect a simple activity view and understand what the AI has been doing without reading raw logs.

A developer should be able to answer usage questions like which tools matter most, where failures happen, and whether high-risk actions are only being previewed or actually executed.
