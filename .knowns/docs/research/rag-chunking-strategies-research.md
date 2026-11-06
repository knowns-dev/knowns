---
id: doc-132d6408c295454b6fcbd57ba6763ba3
title: RAG Chunking Strategies Research
description: Research on RAG chunking strategies from LangChain and LlamaIndex, compared with Knowns implementation
createdAt: '2026-04-01T08:05:05.516Z'
updatedAt: '2026-04-01T08:05:05.516Z'
tags:
  - research
  - rag
  - chunking
  - embedding
  - search
---

## Overview

Research on how major RAG frameworks (LangChain, LlamaIndex) implement chunking, compared with Knowns' current approach. This informs improvements in @doc/specs/semantic-search-quality-improvements.

## Chunking Strategies Across RAG Systems

### 1. Fixed-Size Chunking (Naive)

Simplest approach — split by character/token count with optional overlap.

- **LangChain `CharacterTextSplitter`**: split by separator (default `\n\n`), fixed `chunk_size`, `chunk_overlap`
- **Use case**: unstructured plain text, logs
- **Pros**: simple, predictable chunk sizes
- **Cons**: breaks semantic boundaries, splits mid-sentence

### 2. Recursive Character Splitting

Split by hierarchy of separators: `\n\n` → `\n` → ` ` → `""`.

- **LangChain `RecursiveCharacterTextSplitter`**: recommended default for generic text
- Tries paragraph boundaries first, falls back to sentences, then words
- Supports `chunk_overlap` (typically 10-20% of chunk_size)
- **Typical config**: `chunk_size=1000, chunk_overlap=200`
- **Pros**: respects natural boundaries better than fixed-size
- **Cons**: still character-based, not truly semantic

### 3. Markdown Header Splitting (Structure-Aware)

Split by heading hierarchy, preserving document structure.

- **LangChain `MarkdownHeaderTextSplitter`**: splits on configurable header levels, attaches header metadata
- **LlamaIndex `MarkdownNodeParser`**: splits on headers, maintains `header_stack` for hierarchy, tracks `header_path` in metadata
- **Two-stage pattern** (LangChain best practice):
  1. First split by headers → logical sections
  2. Then apply `RecursiveCharacterTextSplitter` to oversized sections
- **Knowns current approach**: similar to this — `ChunkDocument` splits by heading, then splits oversized sections by paragraph

**Key differences from Knowns:**
- LlamaIndex tracks full header path (e.g., `"API/Endpoints/GET /users"`) — Knowns only tracks `parentSection` for H2
- LlamaIndex handles code blocks (``` detection) to avoid false heading matches — Knowns does not
- LangChain attaches header metadata to each chunk — Knowns stores `section` and `parentSection`
- Both frameworks support overlap between chunks — Knowns does not

### 4. Sentence Window (Fine-Grained + Context)

Split into individual sentences, but store surrounding sentences as metadata.

- **LlamaIndex `SentenceWindowNodeParser`**: each node = 1 sentence, metadata contains `window_size` sentences on each side
- At retrieval time, `MetadataReplacementPostProcessor` replaces the single sentence with the full window before sending to LLM
- **Typical config**: `window_size=3` (3 sentences before + after)
- **Pros**: very precise retrieval, rich context for synthesis
- **Cons**: many more chunks to embed, only useful with LLM synthesis step
- **Relevance to Knowns**: not applicable — Knowns doesn't have an LLM synthesis step, search results go directly to user/agent

### 5. Semantic Chunking (Embedding-Based)

Use embedding similarity to detect topic boundaries.

- **LlamaIndex `SemanticSplitterNodeParser`**:
  1. Split text into sentences
  2. Group consecutive sentences into windows
  3. Embed each group
  4. Calculate cosine distance between consecutive groups
  5. Split where distance exceeds percentile threshold (e.g., 95th percentile)
- **LlamaIndex Topic-based `SemanticChunking`**:
  1. Split into paragraphs
  2. For each paragraph, check if it belongs to current chunk topic (via LLM or embedding similarity)
  3. If same topic → extend chunk; if different → start new chunk
  4. Hard max at 1000 tokens
- **Pros**: chunks align with actual topic boundaries
- **Cons**: requires embedding each sentence (expensive), non-deterministic
- **Relevance to Knowns**: overkill for project management content where markdown structure already provides good boundaries

## Overlap Patterns

| Framework | Default Overlap | How It Works |
|-----------|----------------|--------------|
| LangChain RecursiveCharacter | 200 chars (20% of 1000) | Repeats last N chars at start of next chunk |
| LangChain MarkdownHeader | 0 (structure-based) | No overlap — headers are natural boundaries |
| LlamaIndex SentenceWindow | window_size=3-5 sentences | Stored in metadata, not in chunk content |
| LlamaIndex SemanticSplitter | buffer_size=1 sentence | Sentences around breakpoint included in both chunks |
| **Knowns** | **0** | **No overlap** |

**Industry consensus**: overlap is most important for fixed-size and recursive splitting. For structure-aware splitting (headers), overlap is less critical because headings already provide context boundaries. Knowns' zero-overlap approach is reasonable for markdown-structured content.

## Token Counting Approaches

| Framework | Method |
|-----------|--------|
| LangChain | `tiktoken` (OpenAI tokenizer) by default, configurable `length_function` |
| LlamaIndex | Model-specific tokenizer via `tokenizer` parameter, defaults to `tiktoken` |
| **Knowns** | `len(text)/4` heuristic — **weakest approach** |

Both frameworks use real tokenizers. Knowns' heuristic is the outlier here.

## Model Prefix Handling

| Framework | Approach |
|-----------|----------|
| LangChain | Handled by embedding model wrapper (e.g., `HuggingFaceEmbeddings` auto-applies prefix) |
| LlamaIndex | `HuggingFaceEmbedding` has `query_instruction` and `text_instruction` parameters |
| **Knowns** | **Not implemented** — all text embedded raw |

Both frameworks treat query vs document embedding as distinct operations with model-specific prefixes. This validates Knowns' planned `EmbedQuery()`/`EmbedDocument()` split.

## Comparison: Knowns vs Industry

| Aspect | LangChain | LlamaIndex | Knowns Current | Knowns Planned |
|--------|-----------|------------|----------------|----------------|
| Structure-aware splitting | MarkdownHeaderTextSplitter | MarkdownNodeParser | ChunkDocument (by heading) | Same + H1 fix |
| Oversized chunk handling | RecursiveCharacter 2nd pass | Configurable | Split by paragraph | Same |
| Header hierarchy tracking | Metadata per header level | Full header_path stack | parentSection (H2 only) | Same (out of scope) |
| Code block awareness | Yes | Yes | **No** | Out of scope |
| Chunk overlap | Configurable | Configurable | None | None (OK for structured) |
| Token counting | Real tokenizer | Real tokenizer | len/4 heuristic | **Real tokenizer** |
| Model prefix | Auto per model | query/text instruction | **None** | **EmbedQuery/EmbedDocument** |
| Task-specific chunking | N/A | N/A | By field (desc, ac, plan, notes) | + max_tokens split |

## Key Takeaways for Knowns

1. **Knowns' heading-based approach is aligned with industry best practice** for structured markdown content. LangChain's recommended pattern for markdown is exactly what Knowns does: split by headers, then split oversized sections.

2. **Token counting and model prefix are the real gaps** — both frameworks use real tokenizers and handle model-specific prefixes. These are the highest-impact fixes.

3. **Overlap is not critical** for Knowns' use case. Both LangChain and LlamaIndex default to zero overlap for header-based splitting. Overlap matters more for unstructured text.

4. **Code block awareness** is a nice-to-have — LlamaIndex's `MarkdownNodeParser` explicitly tracks code blocks to avoid false heading matches. Worth noting for future work but not in current scope.

5. **Sentence Window and Semantic Chunking are overkill** for Knowns — these strategies shine for large unstructured documents with LLM synthesis. Knowns' content is already well-structured markdown with clear headings.

## Future Considerations (Out of Current Scope)

- Code block detection in heading parser (avoid `# comment` inside code being treated as heading)
- Full header path tracking (like LlamaIndex's `header_stack`)
- Optional chunk overlap for non-markdown content
- Hybrid chunking: heading-based for markdown, recursive for plain text fields
