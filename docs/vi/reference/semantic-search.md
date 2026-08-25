# Semantic search

Semantic search giúp Knowns tìm docs, tasks, và memories theo ý nghĩa, không chỉ khớp keyword chính xác.

Code search không còn thuộc semantic search. Code intelligence hiện dựa trên LSP và có qua MCP `code` tool.

## Lệnh chính

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

## Lưu ý

Nếu semantic components chưa sẵn sàng, search tự fallback về safe mode thay vì crash.

## Xem thêm

- [Ollama Embedding Models](./ollama-embedding-models.md) — model khuyến nghị, lệnh cài/pull, và bốn trạng thái sẵn sàng của Ollama.
