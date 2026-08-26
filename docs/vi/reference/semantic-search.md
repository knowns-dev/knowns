# Semantic search

Semantic search giúp Knowns tìm docs, tasks, và memories theo ý nghĩa, không chỉ khớp keyword chính xác.

Code search không còn thuộc semantic search. Code intelligence hiện dựa trên LSP và có qua MCP `code` tool.

## Lệnh chính

```bash
ollama pull qwen3-embedding:0.6b
knowns config set settings.semanticSearch.model qwen3-embedding:0.6b
knowns search --status-check
knowns search --reindex
knowns search "how authentication works" --plain
```

Model được pull bằng Ollama và chọn bằng `knowns config`. Xem
[Ollama Embedding Models](./ollama-embedding-models.md) để biết bộ model
khuyến nghị và điểm đánh đổi giữa chúng.

## Search modes

- `keyword`
- `semantic`
- `hybrid`

## Lưu ý

Nếu semantic components chưa sẵn sàng, search tự fallback về safe mode thay vì crash.

## Xem thêm

- [Ollama Embedding Models](./ollama-embedding-models.md) — model khuyến nghị, lệnh cài/pull, và bốn trạng thái sẵn sàng của Ollama.
