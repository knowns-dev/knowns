---
id: doc-578a56a6aa9696341ca2755b5426af83
title: Project Activation Readiness
description: Research note on making project activation and readiness explicit across CLI, browser, runtime, and AI clients.
createdAt: '2026-04-22T08:56:30.376Z'
updatedAt: '2026-04-22T08:56:30.376Z'
tags:
  - research
  - status
  - runtime
  - setup
  - ux
---

# Project Activation Readiness

## Summary

This document describes a clearer activation and readiness model for Knowns projects.

The core idea is simple: when a user or AI client opens a project, Knowns should make it immediately obvious whether the project is ready, what knowledge is active, which runtime surfaces are connected, and what actions are currently available.

## Why This Matters

Knowns already has strong setup and runtime pieces:

- `knowns init`
- `knowns sync`
- browser project status
- runtime queue status
- semantic index setup
- workspace switching
- import syncing

The problem is that these facts are still spread across different commands, outputs, and views.

That means readiness is often inferred instead of stated.

## Current State

Knowns already provides many useful signals:

- whether a project is active
- project path and name
- current CLI or server version
- runtime queue activity
- semantic model setup and reindex steps
- workspace switching behavior
- import setup and syncing

This is a good foundation. The missing piece is a unified readiness story.

## Main Gap

Today, a user may need to mentally combine several separate indicators to answer a very basic question:

Is this project ready for AI-assisted work right now?

That answer should not require reading setup output, runtime output, browser status, and search/index state separately.

## Direction

Knowns should expose a single readiness layer that answers five things clearly:

- which project is active
- what knowledge is loaded or available
- which runtimes or clients are connected
- what search and graph capabilities are ready
- what the AI can do right now

This readiness layer should be canonical and then rendered differently in CLI, browser, and AI-facing APIs.

## What A Good Readiness View Should Show

A useful readiness view should include:

- active project identity
- core counts for docs, tasks, templates, and memories
- relation count if available
- import/source summary
- runtime health and background job activity
- semantic index readiness and freshness
- configured platforms and detected connected clients
- current capability summary

The capability summary is especially important. Status becomes much easier to understand when it ends with an answer like:

- search is ready
- graph is ready
- task and doc updates are allowed
- browser chat is available

## UX Principle

The best readiness message is short, direct, and confidence-building.

A user should be able to glance at something like:

Project is ready. AI now understands 42 docs, 27 tasks, 6 templates, and 184 relations.

And then read a few supporting lines for runtime, search, imports, and capabilities.

## Partial Readiness Matters

The model should not collapse everything into a single binary state.

There are many realistic partial states that still matter:

- project active but semantic model missing
- project active but index stale
- browser running with no active project selected
- runtime available but no connected clients
- imports present but not synced recently

These should be represented explicitly, not hidden behind a vague warning.

## Design Notes

A good readiness model should be:

- fast to compute
- client-neutral
- reusable across CLI, browser, and MCP-aware tools
- expressive enough to explain degraded states

The readiness layer should be a canonical data model first, with UI and CLI presentation built on top.

## Suggested Sequence

1. Define one canonical readiness payload.
2. Extend current status output with knowledge, runtime, and capability fields.
3. Add a dedicated summary command in CLI.
4. Add a readiness card or overview surface in the browser.
5. Reuse the same payload for AI-facing clients.

## What Success Looks Like

A user should be able to open Knowns and understand, within a few seconds, whether the project is active, what is available, and whether AI work can start immediately.

A readiness model done well makes the system feel stable, trustworthy, and easy to adopt.
