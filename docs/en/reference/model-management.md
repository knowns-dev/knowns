# Model Management

Knowns can use local embedding models for semantic search.

## Main commands

```bash
knowns model add <model-name>
knowns model list
knowns model download multilingual-e5-small
knowns model set multilingual-e5-small
knowns model status
knowns model remove <id>
```

## Typical flow

1. list available models
2. add an API-backed model or download a local model
3. set it in project config
4. reindex search if needed

## Related commands

```bash
knowns search --status-check
knowns search --reindex
```

## Why this matters

Without a local model, semantic search is unavailable and Knowns will rely on keyword behavior where applicable.
