---
id: 20260922-1452-opencode-runtime-plugin-ships-dual-v1-v2-entrypoint-in-one-self-contained-file
title: OpenCode runtime plugin ships dual V1/V2 entrypoint in one self-contained file
status: draft
supersedes: []
supersededBy: []
tags: []
sources:
  - internal/runtimeinstall/runtimeinstall.go
  - 'https://opencode.ai/v2/docs/build/plugins/migrate-v1'
relatedDocs:
  - specs/unified-runtime-adapter-install
relatedTasks:
  - KN-D6KBD7
verification: []
reviewState: needs_resolution
reviewBlockers: []
reviewMatches:
  - id: 20260819-1703-remove-the-opencode-chat-ui
    title: Remove the OpenCode Chat UI
    status: accepted
    score: 0.752236
    kind: duplicate
    hash: 3c1cbf1c0148e8f905ae569cdf66edf4bccf7c35344ee32ed6302fdbc1d78acb
    matchedBy:
      - semantic
    tags:
      - chat
      - opencode
      - ui
      - removal
reviewAllowedResolutions:
  - supersede_existing
  - link_as_related
  - reject_new
reviewEvaluatedHash: '0d2ec0bc59bedca11e3b750f2f4ba4b233d215b63a128a64a8a654aeade2acbc'
reviewEvaluatedAt: '2026-09-25T08:33:33.045Z'
createdAt: '2026-09-22T07:52:10.857Z'
updatedAt: '2026-09-25T08:33:33.045Z'
---

## Context


## Decision

The generated ~/.config/opencode/plugins/knowns-runtime-memory.js must remain a single self-contained module whose default export is { id: "knowns.runtime-memory", server, setup }. server(input) is the OpenCode 1.x entrypoint (returns hooks incl. the event handler, injects via client.session.prompt with noReply); setup(ctx) is the OpenCode 2.x entrypoint (subscribes ctx.event.subscribe({signal}), injects via ctx.session.synthetic, returns AbortController cleanup). The file must not import @opencode/plugin or @opencode-ai/plugin so OpenCode 1.x keeps loading it, and event parsing must read both event.properties (v1) and event.data (v2). Verified against opencode 1.18.18 and @opencode/cli 2.0.12.

## Alternatives Considered


## Consequences
