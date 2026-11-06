---
id: doc-acc84e1d1ecd3de433312315caf69ff3
title: Semantic Reference Runtime
description: Specification for semantic references with relation-aware parsing, resolution, graph edges, doc rename rewriting, and WebUI badge rendering.
createdAt: '2026-04-15T09:02:16.425Z'
updatedAt: '2026-04-15T09:05:26.925Z'
tags:
  - spec
  - approved
  - references
  - semantic
  - webui
  - cli
  - mcp
---

## Overview

Specification for Knowns v0.19 semantic reference runtime. This feature extends the current reference system so refs carry explicit relationship meaning, can be resolved into structured runtime objects, and render as semantic badges in WebUI.

Supporting design context: @doc/features/semantic-reference-runtime

## Locked Decisions

- D1: v0.19 scope is full stack: parser, validation, graph, WebUI rendering, and resolve entrypoints.
- D2: Canonical doc semantic refs use path-shaped syntax, e.g. `&commat;doc/security/auth-architecture{implements}`.
- D3: When a doc path changes, v0.19 auto-rewrites affected refs to the new path.
- D4: Memory semantic refs use `&commat;memory-<id>{relation}` syntax.
- D5: Task semantic refs keep the current ID-based syntax, e.g. `&commat;task-42{blocked-by}`.
- D6: Refs without an explicit relation default to `references`.
- D7: `knowns resolve` supports human-readable default output plus `--plain` and `--json` modes.
- D8: In WebUI read mode, semantic refs render as badges.
- D9: Badge style is a single badge combining entity label and relation.
- D10: Unresolved refs still render as a red broken-ref badge.

## Requirements

### Functional Requirements

- FR-1: Knowns parses semantic refs in docs, tasks, and memories using these canonical forms:
  - docs: `&commat;doc/<path>{<relation>}`
  - tasks: `&commat;task-<id>{<relation>}`
  - memories: `&commat;memory-<id>{<relation>}`
- FR-2: Knowns continues to parse plain refs without `{relation}` and resolves them as if they used `{references}`.
- FR-3: The parser returns structured semantic-ref records with at least: raw text, entity type, entity identifier, relation, and normalized target.
- FR-4: Supported relation values in v0.19 are: `implements`, `depends`, `blocked-by`, `follows`, `references`, and `related`.
- FR-5: `knowns resolve <ref>` resolves a single semantic or plain ref and returns the target entity plus relation metadata.
- FR-6: `knowns resolve` default output is human-readable markdown/text, `--plain` emits plain text, and `--json` emits structured JSON suitable for MCP/runtime consumers.
- FR-7: An MCP resolve entrypoint is exposed with equivalent resolution behavior and JSON shape to the CLI `--json` mode.
- FR-8: Validation recognizes semantic refs in docs, tasks, and memories and validates the underlying target entity using existing entity stores.
- FR-9: Broken semantic refs are surfaced by validation with the same target-specific integrity checks as plain refs.
- FR-10: The graph layer emits semantic edge types from resolved refs instead of collapsing them to generic `mention` edges when relation metadata exists.
- FR-11: WebUI read-mode rendering converts resolved semantic refs into single badges showing entity label and relation in one visual unit.
- FR-12: Plain refs in WebUI may render in the same badge system using the default `references` relation, or an equivalent normalized visual that still preserves relation semantics.
- FR-13: Unresolved semantic refs in WebUI render as visible red broken-ref badges instead of disappearing or falling back to raw hidden metadata.
- FR-14: When a doc path changes through a supported rename/update flow, Knowns rewrites affected `&commat;doc/<path>` refs to the new path.
- FR-15: Auto rewrite updates refs in all supported Knowns-managed content types that can contain doc refs: docs, task description/plan/notes, and memory content.
- FR-16: Auto rewrite preserves any semantic relation suffix during rewrite, e.g. `&commat;doc/old/path{implements}` becomes `&commat;doc/new/path{implements}`.
- FR-17: Auto rewrite only changes refs that resolve to the renamed doc and must not rewrite unrelated path-like text.

### Non-Functional Requirements

- NFR-1: Existing plain refs continue working without any user migration requirement.
- NFR-2: Semantic ref parsing and resolution must be shared across validation, graph building, resolve entrypoints, and WebUI preparation to avoid divergent regex behavior.
- NFR-3: WebUI rendering must preserve readable content flow and not require users to view raw markdown syntax in read mode.
- NFR-4: Broken ref states must be visible and inspectable, not silently ignored.
- NFR-5: The new runtime should remain compatible with current retrieval and reference-expansion flows even when relation metadata is added.

## Acceptance Criteria

- [ ] AC-1: A doc containing `&commat;doc/security/auth-architecture{implements}` resolves to the target doc and relation `implements`.
- [ ] AC-2: A task containing `&commat;task-42` resolves as relation `references` without requiring `{references}` in source text.
- [ ] AC-3: A memory ref using `&commat;memory-abc123{follows}` resolves correctly in validation and resolve output.
- [ ] AC-4: `knowns resolve "&commat;doc/security/auth-architecture{implements}" --json` returns structured JSON with entity type, target identifier/path, relation, and resolved status.
- [ ] AC-5: The MCP resolve tool returns equivalent structured resolution data for the same input ref.
- [ ] AC-6: Graph output uses semantic edge types such as `implements`, `blocked-by`, or `related` when relation metadata exists.
- [ ] AC-7: WebUI read mode renders a resolved semantic ref as a single badge, e.g. `[ Authentication Architecture · implements ]`.
- [ ] AC-8: WebUI renders unresolved refs as red broken-ref badges.
- [ ] AC-9: Renaming a doc path rewrites affected doc refs across supported Knowns-managed content and keeps the original relation suffix intact.
- [ ] AC-10: After doc rename, validation passes for rewritten refs and they continue resolving to the renamed doc.

## Scenarios

### Scenario 1: Resolve a semantic doc ref
**Given** a doc exists at path `security/auth-architecture`
**When** a user or runtime resolves `&commat;doc/security/auth-architecture{implements}`
**Then** Knowns returns the doc entity and relation `implements`
**And** graph and WebUI consumers can use the same resolved metadata.

### Scenario 2: Plain ref defaults to references
**Given** a task contains `&commat;task-42`
**When** Knowns parses the ref
**Then** it treats the relation as `references`
**And** resolve output includes that normalized relation.

### Scenario 3: Doc rename rewrites semantic refs
**Given** docs, tasks, and memories contain refs to `&commat;doc/patterns/auth{implements}`
**And** the referenced doc is renamed to `security/auth-architecture`
**When** the rename flow completes
**Then** affected refs are rewritten to `&commat;doc/security/auth-architecture{implements}`
**And** validation no longer reports the old path as broken.

### Scenario 4: Unresolved semantic ref in WebUI
**Given** content contains a semantic ref whose target cannot be resolved
**When** the content is rendered in WebUI read mode
**Then** the ref appears as a red broken-ref badge
**And** users can still see that a reference exists and is broken.

### Scenario 5: CLI and MCP share resolution semantics
**Given** the same semantic ref input
**When** it is resolved through CLI `knowns resolve --json` and the MCP resolve tool
**Then** both return equivalent entity identity, relation, and resolved-status semantics.

## Technical Notes

- Use a shared semantic reference parser/resolver rather than extending separate regex implementations independently in validate, graph, search/retrieve, and UI preparation.
- The parser should preserve enough metadata to support rewriting, graph edge generation, WebUI rendering, and resolve output from one normalized representation.
- Doc rename rewrite should operate only on parsed refs, not broad text replacement.
- The spec assumes a supported rename/update flow exists for docs; if that flow is missing, the implementation must add one or define where rewrite hooks run.

## Open Questions

- [ ] Should plain refs render in WebUI as badges with implicit `references`, or as a lighter visual variant that still preserves normalized relation semantics?
- [ ] Should `knowns resolve` accept multiple refs in one invocation, or stay single-ref only in v0.19?
- [ ] Should relation values be hard-failed outside the v0.19 allowlist, or treated as warnings for forward compatibility?
