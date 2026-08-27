# Semantic Search

Semantic search helps Knowns search docs, tasks, and memories by meaning instead of only exact keywords.

Code search is no longer part of semantic search. Code intelligence is LSP-based and available through the MCP `code` tool.

## Main commands

```bash
ollama pull qwen3-embedding:0.6b
knowns config set settings.semanticSearch.model qwen3-embedding:0.6b
knowns search --status-check
knowns search --reindex
knowns search "how authentication works" --plain
```

Models are pulled with Ollama and selected with `knowns config`. See
[Ollama Embedding Models](./ollama-embedding-models.md) for the recommended
set and the tradeoff between them.

## Search modes

- `keyword`
- `semantic`
- `hybrid`

## Operational note

If semantic components are unavailable, the relevant search paths can safely fall back instead of crashing.

## See also

- [Ollama Embedding Models](./ollama-embedding-models.md) — recommended models, install/pull commands, and the four Ollama readiness states.
