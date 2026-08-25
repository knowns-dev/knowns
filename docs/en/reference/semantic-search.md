# Semantic Search

Semantic search helps Knowns search docs, tasks, and memories by meaning instead of only exact keywords.

Code search is no longer part of semantic search. Code intelligence is LSP-based and available through the MCP `code` tool.

## Main commands

```bash
knowns model list
knowns model download multilingual-e5-small
knowns model set multilingual-e5-small
knowns search --status-check
knowns search --reindex
knowns search "how authentication works" --plain
```

## Search modes

- `keyword`
- `semantic`
- `hybrid`

## Operational note

If semantic components are unavailable, the relevant search paths can safely fall back instead of crashing.

## See also

- [Ollama Embedding Models](./ollama-embedding-models.md) — recommended models, install/pull commands, and the four Ollama readiness states.
