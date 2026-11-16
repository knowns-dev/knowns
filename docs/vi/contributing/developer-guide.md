# Developer guide

Bắt đầu từ đây nếu muốn đóng góp cho Knowns.

## Đọc trước

1. `README.md`
2. `docs/en/README.md`
3. MCP `initial` và on-demand `help` output khi làm việc qua AI assistant

## Thư mục quan trọng

- `cli/src/cli/` - command framework và các command
- `cli/src/mcp/handlers/` - MCP tool handlers
- `cli/src/search/` - chunking, embeddings, lexical và vector search
- `cli/src/domain/` - library code dùng chung (codegen, validation, decision review, ...)
- `cli/src/storage/` - stores, locks, history
- `cli/instructions/` - skills (`kn-*`) và guidelines, được `cli/scripts/gen-instructions.ts` nhúng vào binary
- `cli/test/` - unit test, differential test và e2e test (`cli/test/e2e`)
- `ui/`

Go đã bị xóa khỏi repository sau 0.35.0. Không còn gì để build hay test bằng Go.

## Lệnh hay dùng

Cần Bun 1.3.12+.

```bash
make ui                 # build Web UI để nhúng vào binary
make build              # binary cho máy hiện tại -> cli/dist/<os>-<arch>/knowns
make ts-build           # build cả 6 target
make test               # cd cli && bun run check && bun run test
make test-e2e           # cli/test/e2e chạy với binary đã build (KNOWNS_TS_BIN)
make test-e2e-semantic  # cùng suite, bật thêm test semantic search
make test-e2e-ui        # Playwright UI e2e
make lint               # bun run check (typecheck + Biome)
make dev-ts             # Chỉ TypeScript server
make dev-ui             # Chỉ Vite dev UI
make dev-all-ts         # TypeScript server + Vite dev UI
```

Các differential test so sánh CLI với Go 0.34.1, build từ commit cố định `069954a`. Chúng cần Go toolchain và bị skip nếu không có:

```bash
eval "$(make -s go-oracle)"   # chạy cli/scripts/go-oracle.ts, export KNOWNS_GO_SRC và KNOWNS_GO_BIN
cd cli && bun run test
```

## Nguyên tắc

Khi behavior thay đổi, giữ code, tests, và docs đồng bộ trong cùng một pass.
