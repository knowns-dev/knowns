---
id: doc-d90652964aa9f401d52446b1d5f3501a
title: Structural Knowledge Retrieval
description: Research note on moving Knowns from search-first retrieval toward relation-aware structural knowledge retrieval.
createdAt: '2026-04-22T08:56:30.308Z'
updatedAt: '2026-04-22T08:57:37.385Z'
tags: []
---

# Structural Knowledge Retrieval

## Summary

This document captures a product and architecture direction for making Knowns relation-aware at retrieval time, not just at render time.

Today Knowns already has important building blocks:

- semantic references with typed relations
- structured reference resolution
- graph views across knowledge entities
- code graph edges with typed relationships
- retrieval expansion through references

The missing layer is a retrieval mode that can answer structural questions directly instead of treating structure as a secondary annotation on top of text search.

## Why This Matters

Knowns already connects tasks, docs, memories, templates, and code. That gives it a chance to become more than a search surface.

A stronger structural retrieval layer would let the system answer questions like:

- which tasks implement this document
- which task is blocked by which other task
- which docs depend on this doc
- which templates fit a given feature, stack, or project type
- which task acceptance criteria relate to which implementation plan items

That is useful for humans, AI agents, and graph exploration alike.

## Current State

Knowns already supports relation-aware references, including doc references with typed relations and task references with blocking relations.

It also already supports:

- shared semantic reference parsing and resolution
- relation-aware graph edges
- field-backed links such as parent and spec references
- typed code edges such as `implements`

This means the system already has relation vocabulary and relation extraction in multiple layers.

What it does not yet have is a first-class retrieval flow centered on relation traversal.

## Main Gap

The current model is still mostly query-first.

A user can search for text and sometimes expand references, but cannot reliably ask the system to traverse the knowledge graph as a retrieval primitive.

That creates a gap between:

- what Knowns already knows structurally
- what Knowns can currently retrieve in a direct, reusable way

## Direction

The next step is not to replace search. It is to add a second retrieval mode that is explicitly structure-aware.

That mode should:

- start from a resolved entity or semantic reference
- traverse typed relations in a controlled way
- return relation-aware results with source, target, direction, and explanation
- work consistently across CLI, MCP, and WebUI

The most important property is that relation traversal becomes a real capability instead of an implementation detail hidden inside graph rendering or mention parsing.

## Good First Targets

The most practical first targets are the relations that already exist or are nearly normalized:

- task parent
- task spec
- inline `implements`
- inline `depends`
- inline `blocked-by`
- inline `references`
- code graph typed edges

Starting with these keeps the first version grounded in real existing data instead of inventing a large abstract relation system up front.

## Design Notes

A good structural retrieval layer should stay constrained in the beginning.

That likely means:

- a small allowlist of supported relation types
- bounded traversal depth
- explicit inbound or outbound direction
- filters on type, tags, status, assignee, and import state

The goal is not a general graph query language in v1. The goal is reliable relation-aware retrieval that can be exposed safely and predictably.

## Biggest Constraint

The strongest architectural constraint is entity identity.

Docs in particular still lean heavily on path identity, while relation-aware retrieval becomes much more powerful when entity identity is stable and independent from mutable paths.

That does not block early work, but it affects how durable structural queries can become over time.

## Suggested Sequence

1. Introduce a structural retrieval result model.
2. Traverse existing field-backed and parsed relation edges.
3. Expose a dedicated read-only CLI and MCP entrypoint.
4. Add WebUI relation views and relation-scoped filters.
5. Extend to richer relations such as template fit and task sub-entities.

## What Success Looks Like

Knowns should eventually be able to answer structural questions directly, with outputs that are understandable to both humans and AI clients.

At that point, references, graph edges, and retrieval are no longer separate ideas. They become one coherent knowledge navigation layer.
