---
title: Doc History and Retention
description: ''
createdAt: '2026-06-26T05:13:25.663Z'
updatedAt: '2026-06-26T05:13:25.663Z'
tags:
  - guide
  - docs
  - history
  - security
---

# Doc History and Retention

Document history preserves prior document states so users can inspect changes, compare revisions, and restore older content. Treat that history as part of the project data, not as a short-lived editor undo stack.

## Sensitive Content Risk

When a document is changed, Knowns may store previous content in revision history. Section edits try to store only the changed section when possible, but whole-document edits, checkpoints, restores, and retained snapshots can include larger portions of a document.

If a secret, credential, token, private customer detail, or other sensitive value is saved in a doc, removing it from the current document does not automatically remove it from historical revisions. Rotate exposed credentials and treat historical project storage as sensitive until old history has been purged.

## Retention Behavior

By default, document history is preserved unless retention is applied. Retention can limit history by maximum retained versions, maximum age, or both.

When retention removes old detail, Knowns keeps the retained history coherent by converting the first retained revision into a checkpoint. The response includes a retention gap so CLI, MCP, API, and WebUI consumers can show that older detail was compacted or purged instead of silently pretending the timeline is complete.

## Restore Behavior

Restoring a section or a whole document creates a new revision. It does not rewrite or erase the old revision. This keeps the audit trail understandable, but it also means sensitive content may continue to exist in earlier retained history until retention removes it.

## Operational Guidance

Do not store long-lived secrets in docs. If sensitive content is accidentally saved, rotate the secret first, then apply the strictest available retention policy for the project history that still meets operational requirements.

When reviewing history in WebUI or through MCP/API, watch for retention gap markers and missing audit links. A missing audit link means the revision can still be valid, but it could not be connected to an audit event.
