# Model management

Knowns dùng local embedding models cho semantic search.

## Lệnh chính

```bash
knowns model add <model-name>
knowns model list
knowns model download multilingual-e5-small
knowns model set multilingual-e5-small
knowns model status
knowns model remove <id>
```

## Flow

1. List models có sẵn
2. Add API-backed model hoặc download local model
3. Set vào project config
4. Reindex nếu cần

## Lệnh liên quan

```bash
knowns search --status-check
knowns search --reindex
```

## Lưu ý

Không có local model → semantic search không hoạt động → Knowns fallback về keyword search.
