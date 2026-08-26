# Cài đặt

Cài `knowns` CLI trước. Việc cài đặt chỉ làm cho command khả dụng; bạn vẫn cần chạy `knowns init` trong từng repository muốn quản lý bằng Knowns.

## Yêu cầu

- Terminal trên macOS, Linux, hoặc Windows
- Git (nếu muốn `knowns init` nhận diện repo)
- [Ollama](https://ollama.com/download) nếu bạn muốn dùng semantic search

## Nền tảng được hỗ trợ

| Nền tảng | Gói CLI |
| --- | --- |
| macOS Apple Silicon | `darwin-arm64` |
| macOS Intel (x86_64) | `darwin-x64` |
| Linux x64 | `linux-x64` |
| Linux ARM64 | `linux-arm64` |
| Windows x64 | `win32-x64` |

Mọi nền tảng đều nhận cùng một binary duy nhất, không kèm thư viện chia sẻ
nào, nên CLI hoạt động giống hệt nhau trên tất cả.

Semantic search là tùy chọn và cần một embedding provider — Ollama chạy local,
hoặc một endpoint OpenAI-compatible của bên thứ ba. Không có provider, Knowns
vẫn chạy: search fallback về keyword/BM25. Xem
[Ollama Embedding Models](../reference/ollama-embedding-models.md).

## Homebrew

```bash
brew install knowns-dev/tap/knowns
```

Cách nên dùng trên macOS/Linux.

## npm

```bash
npm install -g knowns
```

Phù hợp nếu đã dùng Node tooling sẵn.

## Shell installer (macOS/Linux)

```bash
curl -fsSL https://knowns.sh/script/install | sh
```

## PowerShell installer (Windows)

```powershell
irm https://knowns.sh/script/install.ps1 | iex
```

## Build từ source

```bash
go build -o ./bin/knowns ./cmd/knowns
```

Dùng khi đang dev chính Knowns.

## Kiểm tra

```bash
knowns --version
```

Nếu command in ra version, CLI đã cài xong. Tiếp theo, vào repository bạn muốn quản lý và chạy quick start.

## Không muốn cài global?

Chạy qua npx:

```bash
npx knowns init
```

## Gỡ cài đặt

Xem [Gỡ cài đặt](./uninstall.md) cho Homebrew, npm, shell installer, PowerShell, Go install, cleanup runtime adapter, và các project files được giữ lại có chủ ý.

## Tiếp theo

- [Quick start](./quick-start.md)
- [Gỡ cài đặt](./uninstall.md)
