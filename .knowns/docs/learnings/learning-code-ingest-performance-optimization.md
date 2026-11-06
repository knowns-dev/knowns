---
id: doc-831312e70fd733e966fe2ac8bea8d88b
title: 'Learning: Code Ingest Performance Optimization'
description: Learnings from optimizing code ingest pipeline — 5x speedup via batch embedding, content compaction, and parser pooling
createdAt: '2026-04-30T13:00:36.691Z'
updatedAt: '2026-04-30T13:00:36.691Z'
tags:
  - learning
  - performance
  - embedding
  - ast
  - code-intelligence
---

# Learning: Code Ingest Performance Optimization

## Patterns

### Batch Embedding with Length-Sorted Content
- **What:** Sort code symbols by embedding content length before batching ORT inference. Short symbols batch together (minimal padding), long symbols batch separately.
- **When to use:** Any ORT/ONNX batch inference where inputs vary widely in length.
- **Impact:** 5x wall-clock speedup (1m27s → 17s on 3700+ symbols).
- **Why it works:** ORT pads all texts in a batch to the longest one. Without sorting, one long function in a batch of 64 forces all 63 short symbols to be padded to max length → wasted compute.

### Compact Embedding Content for Code Symbols
- **What:** Use signature + edge summary instead of full source code for embedding content. Functions/methods get signature only. Classes get member signature list.
- **When to use:** Code symbol embedding where the model has limited token budget (512 tokens).
- **Why:** Full source code gets truncated by the model anyway. Signature + relationships (calls, imports, instantiates) capture the semantic meaning better for search.

### Parser Instance Pooling
- **What:** Pool tree-sitter parser instances per language extension using a bounded stack. Avoids alloc/dealloc per file.
- **When to use:** Sequential file parsing with tree-sitter CGO bindings.
- **Impact:** Minor but measurable — eliminates per-file parser creation overhead.

## Decisions

### Sort + Adaptive Batch Size
- **Chose:** Sort by content length + adaptive batch size (64 for short, 32 for long)
- **Over:** Fixed batch size, parallel embedding goroutines
- **Tag:** GOOD_CALL
- **Outcome:** Simple change, massive impact. No concurrency complexity.
- **Recommendation:** Always sort by input length before batching any padded inference.

### Add Java/Rust/C# on CGO Path Now
- **Chose:** Add languages to current Go CGO tree-sitter path
- **Over:** Wait for sidecar migration to complete
- **Tag:** TRADEOFF
- **Outcome:** Users get new language support immediately. Will need to port to sidecar later but the AST node type mapping is reusable.

### Truncate Content at 2000 Chars
- **Chose:** Hard truncate embedding content at 2000 chars before tokenization
- **Over:** Let tokenizer handle full text then truncate at token level
- **Tag:** GOOD_CALL
- **Outcome:** Reduces tokenizer CPU overhead significantly. Model uses max 512 tokens ≈ 2000 chars for code.

## Failures

### WebUI Memory Page Silent Failure
- **What went wrong:** Memory page showed "0 entries" despite API returning 77 entries.
- **Root cause:** Frontend `Promise.all([memoryApi.list(), workingMemoryApi.list()])` — the `/api/working-memories` route was removed from backend but frontend still called it → 404 → `Promise.all` rejects → catch block runs → both persistent and working entries stay as empty arrays.
- **Time lost:** ~20 minutes debugging.
- **Prevention:** When removing a backend route, always grep frontend for the route path. Or use `Promise.allSettled` instead of `Promise.all` for independent fetches.

### Duplicate "Semantic search ready" Message
- **What went wrong:** `knowns sync` printed "✓ Semantic search ready (model: ...)" twice.
- **Root cause:** `ensureProjectAndGlobalSemanticReady` calls `ensureSemanticStoreReady` twice (project + global), each calling `runSemanticSetup` which printed the message independently.
- **Prevention:** Print status messages at the orchestration level, not inside reusable helper functions.
