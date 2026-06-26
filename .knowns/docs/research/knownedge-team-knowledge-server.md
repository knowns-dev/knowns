---
title: Knownedge Team Knowledge Server
description: Research brief for a separate self-hosted team knowledge and memory server built on Knowns primitives.
createdAt: '2026-06-19T08:33:04.850Z'
updatedAt: '2026-06-19T08:33:04.850Z'
tags:
  - research
  - knownedge
  - team
  - memory
  - knowledge
  - decision-review
  - rbac
  - self-hosted
  - product
---

# Knownedge Team Knowledge Server

## Summary

Knownedge is a proposed separate repo/product for a self-hosted team knowledge and memory server built on top of Knowns ideas.

The goal is not just to sync agent memories. The product should act as a shared governance layer for agent knowledge: team members and agents can propose knowledge, authorized reviewers can approve it, and agents across the team can apply the current accepted context from the next interaction.

This should live outside `knowns-go` as its own repo. `knowns-go` remains the local CLI/MCP/workflow engine; Knownedge becomes the team server, source of truth, review layer, and sync surface.

Source context: @memory/pot4t0

## Product Thesis

Teams do not only need shared vector memory. They need shared, reviewed, role-aware knowledge that agents can trust.

A useful team agent memory system must answer:

- Which guidance is current?
- Who proposed it?
- Who approved it?
- Which older guidance does it replace?
- Which team, project, repo, or service does it apply to?
- Which agents should use it immediately?
- Which similar or conflicting Decisions already exist?

The differentiated product is the combination of review, role-aware approval, Decision conflict search, and immediate agent context sync.

## Core Entity Types

### Memory

Short reusable facts, preferences, gotchas, and implementation notes.

Examples:

- `Qdrant collections use org_id + workspace_id naming.`
- `Do not use Chroma in project X unless explicitly approved.`
- `Support triage agents should prefer account-level history before ticket-level notes.`

Memory is optimized for compact runtime injection.

### Decision

A current or historical team/project rule that affects future work.

Examples:

- `Use Qdrant instead of Chroma for vector storage.`
- `All billing events must be idempotent by event_id.`
- `Project X uses server-side feature flags, not client-only flags.`

Decision should support status, review, supersession, conflict detection, and typed search.

### KnowledgeDoc

Longer-form knowledge for architecture, patterns, business use cases, domain rules, and implementation playbooks.

Examples:

- `Architecture: Vector Retrieval Service`
- `Pattern: Tenant-scoped repository sync`
- `Business Use Case: B2B support triage flow`
- `Playbook: Adding a new vector backend`

KnowledgeDoc gives agents the why and how, not only short facts.

### ReviewRequest

A request for authorized users to review a proposed Memory, Decision, or KnowledgeDoc.

ReviewRequest should include proposed content, source context, similar items, conflicting Decisions, reviewer role requirements, status, comments, and final resolution.

### Notification

A role-aware event delivered to relevant people and agents.

Examples:

- `decision.proposed`
- `decision.accepted`
- `knowledge_doc.updated`
- `review.requested`
- `context_pack.version_changed`

### ContextPack

A bounded payload prepared for agents. It should include the most relevant accepted Decisions, active Memories, and approved KnowledgeDocs for a given team/project/repo/task context.

## Roles And Permissions

A simple MVP role model is enough:

- `Viewer`: can read accepted/current knowledge.
- `Contributor`: can propose Memory, Decision, and KnowledgeDoc changes.
- `Maintainer`: can review and approve within a workspace, project, repo, or service scope.
- `Admin`: can manage members, permissions, policy, and override review outcomes.

A contributor's agent can propose a Decision, but cannot make it current unless the user has approval rights for that scope.

## Decision Review Flow

Example: user B proposes `Use Qdrant instead of Chroma` for project X.

1. B or B's agent creates a proposed Decision.
2. The server records `createdBy = B`, `scope = project X`, `status = proposed`.
3. The server searches similar and same-category Decisions.
4. The server detects duplicates, conflicts, supersession candidates, and related KnowledgeDocs.
5. The server creates a ReviewRequest for users with `Maintainer` or `Admin` role in project X.
6. User A, as project Admin, sees the ReviewRequest in the role-aware Review Inbox.
7. A can approve, request changes, supersede an existing Decision, link as related, merge/update existing guidance, or reject.
8. If approved, the Decision becomes current for project X.
9. Team agents receive a version change event and use the updated ContextPack from the next prompt or task.

## Similar Decision Search

Decision review must include typed and semantic search before acceptance.

Search dimensions:

- `type`: architecture, tech-stack, business-rule, workflow, security, data-model.
- `scope`: org, workspace, project, repo, service.
- `topic`: vector-db, auth, billing, deployment, retrieval, support-triage.
- semantic similarity over title, content, rationale, consequences, and source links.
- current and historical status: accepted, proposed, superseded, rejected, archived.

Review UI should show:

- exact or near duplicates
- Decisions in the same category
- conflicting current Decisions
- superseded historical Decisions
- related KnowledgeDocs
- relevant Memories

Reviewer actions:

- approve as new current Decision
- supersede existing Decision
- link as related
- merge/update existing Decision
- reject as duplicate
- request changes

## Runtime Sync Semantics

"Apply immediately" should mean agents use the new accepted context from the next prompt, task, or context refresh.

It should not mean automatically changing production code, infrastructure, or configuration without a separate approved workflow.

Recommended mechanics:

- Local agents keep a cache keyed by `teamStoreVersion` or scoped `contextVersion`.
- Agents call `GET /context-pack` before a task starts or before prompt-level runtime injection.
- Server emits SSE/WebSocket events when accepted knowledge changes.
- Clients invalidate cache on version changes.
- Default agent retrieval only includes accepted/current knowledge.

## Retrieval Defaults

Default retrieval should include:

- accepted current Decisions
- active Memories
- approved KnowledgeDocs

Default retrieval should exclude:

- proposed items
- rejected items
- superseded Decisions
- archived items
- stale Memories unless explicitly requested

Review and debug modes may opt into non-current and historical guidance.

## Repo Boundary

Knownedge should be a separate repo.

Responsibilities of Knownedge:

- multi-user identity
- org/team/workspace/repo hierarchy
- RBAC and object-level permissions
- role-aware Review Inbox
- server-grade storage
- tenant-aware vector indexing
- Decision conflict search
- review notifications
- actor-aware audit
- ContextPack API
- sync protocol for local clients and agents

Responsibilities of `knowns-go`:

- local CLI and MCP workflows
- local project/task/doc/memory operations
- runtime hook integration
- optional client commands for Knownedge sync/query
- local cache and fallback behavior

## MVP Scope

A narrow MVP should include:

- single self-hosted org
- project/repo namespaces
- users and roles: Viewer, Contributor, Maintainer, Admin
- Memory, Decision, and KnowledgeDoc entities
- proposed/accepted/superseded/rejected statuses for Decision
- role-aware Review Inbox
- similar Decision search during review
- active/current-only ContextPack retrieval
- SSE/WebSocket notification for context version changes
- Knowns CLI/MCP integration as client surface

## Non-Goals For MVP

- multi-org billing
- public SaaS tenancy
- automatic production code or infra mutation
- complex workflow automation engine
- full Notion/wiki replacement
- replacing `knowns-go`

## Open Questions

- Should Knownedge be implemented in Go to reuse Knowns packages directly, or TypeScript for faster web product iteration?
- Should Memory/Decision/KnowledgeDoc be file-exportable markdown, database-native, or both?
- Which vector backend should be default for self-hosted deployments: Qdrant, Postgres vector, or pluggable adapters?
- Should local Knowns stores push proposed items to Knownedge automatically, or only on explicit command?
- How strict should review requirements be for low-risk Memories versus high-impact Decisions?

## Related Knowns Foundations

- @doc/specs/2026-06-18/memory-decision-review-ui
- @doc/specs/multi-store-semantic-memory-retrieval
- @doc/specs/2026-06-18/runtime-memory-per-prompt-injection
- @doc/specs/ai-permission-model
- @doc/specs/mcp-audit-trail-and-tool-stats
- @doc/specs/knowns-hub-mode
