# Developer guide

Bắt đầu từ đây nếu muốn đóng góp cho Knowns.

## Đọc trước

1. `README.md`
2. `docs/en/README.md`
3. MCP `initial` và on-demand `help` output khi làm việc qua AI assistant

## Thư mục quan trọng

- `internal/cli/`
- `internal/mcp/handlers/`
- `internal/search/`
- `internal/runtimeinstall/`
- `internal/codegen/`
- `internal/storage/`
- `tests/`
- `ui/`

## Lệnh hay dùng

```bash
go build -o ./bin/knowns ./cmd/knowns
go test ./...
go test ./internal/cli -count=1
go test ./tests -count=1
```

## Nguyên tắc

Khi behavior thay đổi, giữ code, tests, và docs đồng bộ trong cùng một pass.
