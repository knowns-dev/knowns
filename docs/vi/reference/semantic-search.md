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

## Vector store

Vector được lưu trong Qdrant. Mặc định Knowns tự quản lý một process Qdrant local
cho bạn, không cần cài hay cấu hình gì thêm.

Nếu managed binary không chạy được trên platform của bạn, hoặc bạn đã có sẵn
Qdrant ở đâu đó, hãy trỏ Knowns vào endpoint đó. Xem
[External Qdrant](./external-qdrant.md).

## Lưu ý

Nếu semantic components chưa sẵn sàng, search tự fallback về safe mode thay vì crash.

## Xem thêm

- [Ollama Embedding Models](./ollama-embedding-models.md) — model khuyến nghị, lệnh cài/pull, và bốn trạng thái sẵn sàng của Ollama.
- [External Qdrant](./external-qdrant.md) - kết nối tới Qdrant bạn tự chạy, và giới hạn platform của managed binary.
