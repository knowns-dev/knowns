---
id: 20260914-1147-adapters-send-each-file-its-own-lsp-language-identifier
title: Adapters send each file its own LSP language identifier
status: accepted
supersedes: []
supersededBy: []
tags:
  - lsp
  - adapters
  - convention
sources:
  - '@task-KN-PBTSN9'
  - '@doc/specs/2026-07-20/priority-built-in-lsp-expansion'
relatedDocs:
  - specs/2026-07-20/priority-built-in-lsp-expansion
relatedTasks:
  - KN-PBTSN9
verification:
  - 'source:@task-KN-PBTSN9'
  - 'source:@doc/specs/2026-07-20/priority-built-in-lsp-expansion'
  - 'task:@task-KN-PBTSN9:done'
verifiedAt: '2026-09-25T05:40:18.606Z'
createdAt: '2026-09-14T04:47:44.134Z'
updatedAt: '2026-09-25T05:40:18.606Z'
---

## Context

The TypeScript adapter served .ts, .tsx, .js and .jsx under one registry ID and sent that ID as the didOpen languageId for every file. tsserver chooses the script kind from languageId, so JSX was parsed as TypeScript. Through Knowns MCP, ui/src/pages/AuditPage.tsx returned 29 <unknown> symbols and 4 string literals as symbol names; a .jsx file produced 22 syntax diagnostics; a .js file received TypeScript-only errors.

## Decision

When an adapter claims extensions whose LSP language identifiers differ, it implements lsp.PathDocumentSyncAdapter and maps every claimed extension explicitly. The registry ID is for routing only and is never assumed to be a valid languageId for every file the adapter serves. Each such adapter carries a test that fails when a claimed extension has no explicit mapping.

## Alternatives Considered

A central extension-to-languageId table in the LSP server. Rejected because identifiers are server-specific (terraform-vars exists only for terraform-ls) and each adapter already owns the extensions it claims.

## Consequences

The Terraform adapter (terraform, terraform-vars) and the TypeScript adapter (typescript, typescriptreact, javascript, javascriptreact) follow this. Adding .mjs or .cjs, or adapters such as Vue or Svelte, must add the mapping together with the extension. Adapters that serve a single identifier need nothing.
