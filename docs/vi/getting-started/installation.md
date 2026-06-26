# Cài đặt

Cài `knowns` CLI trước. Việc cài đặt chỉ làm cho command khả dụng; bạn vẫn cần chạy `knowns init` trong từng repository muốn quản lý bằng Knowns.

## Yêu cầu

- Terminal trên macOS, Linux, hoặc Windows
- Git (nếu muốn `knowns init` nhận diện repo)
- Tùy chọn: local model cho semantic search

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

## Tiếp theo

- [Quick start](./quick-start.md)
