---
id: 20261103-0204-knowns-runtime-is-typescript-compiled-with-bun
title: Knowns runtime is TypeScript compiled with Bun
status: rejected
supersedes: []
supersededBy: []
tags:
  - architecture
  - runtime
  - typescript
  - distribution
sources:
  - '@doc/specs/2026-11-03/knowns-typescript-rewrite'
relatedDocs:
  - specs/knowns-go-rewrite
  - specs/2026-11-03/knowns-typescript-rewrite
relatedTasks: []
verification: []
reviewState: ''
reviewBlockers: []
reviewMatches: []
reviewAllowedResolutions: []
reviewEvaluatedHash: '379e65f32363ea7f71c6034777c54275af036b613c8a67e51b836d99a84fb0a5'
reviewEvaluatedAt: '2026-11-02T19:05:43.356Z'
createdAt: '2026-11-02T19:04:43.983Z'
updatedAt: '2026-11-03T10:09:06.705Z'
---

## Context

Knowns moved from TypeScript to Go in 2026-03 (spec specs/knowns-go-rewrite) for a single binary, fast startup, and easy cross-compilation. Since then the heavy native pieces left the core: ONNX embedding was replaced by Ollama over HTTP, the vector store moved to Qdrant over HTTP, and tree-sitter parsing was replaced by LSP. The maintainer does not work comfortably in Go, which makes reviewing ~105k lines of Go (including agent-written changes) a long-term risk, and the contributor pool for TypeScript is larger. Install failures seen in issues #133, #138, #144, #155 come from install scripts and OS handling, not from the language.

## Decision

1. The Knowns CLI, MCP server, and HTTP server are written in TypeScript and shipped as one Bun-compiled binary per platform (darwin, linux, windows x x64, arm64).
2. Distribution keeps the existing paths: per-platform npm packages and install.sh / install.ps1.
3. The .knowns/ data format stays readable by the last Go release (0.34.x); the TypeScript runtime never writes data that release cannot read.
4. The binary stays within 100MB uncompressed including the embedded UI, and `knowns --version` and MCP readiness each complete within 150ms.

## Alternatives Considered

Keep Go: rejected because the maintainer cannot review the code comfortably. Node with a plain npm package: rejected because it reintroduces Node version and global npm permission failures at install time. Strangler migration through the Go binary: rejected by the maintainer in favour of a one-time switch.

## Consequences

Binary size grows from ~35MB to an expected 60-100MB. Go code is frozen during the rewrite except for security fixes. The rewrite ships as v1.0.0; 0.34.x remains installable for rollback. This decision supersedes the runtime choice recorded in specs/knowns-go-rewrite once accepted.
