# Gỡ cài đặt

Dùng cách gỡ tương ứng với cách bạn đã cài Knowns. Gỡ CLI mặc định không xóa project context.

## Homebrew

```bash
brew uninstall knowns
```

## npm

```bash
npm uninstall -g knowns
```

## Shell installer trên macOS/Linux

```bash
curl -fsSL https://knowns.sh/script/uninstall | sh
```

Nếu trước đó bạn cài vào thư mục custom, truyền lại cùng thư mục cho uninstaller:

```bash
curl -fsSL https://knowns.sh/script/uninstall | KNOWNS_INSTALL_DIR="$HOME/.local/bin" sh
```

## PowerShell installer trên Windows

```powershell
irm https://knowns.sh/script/uninstall.ps1 | iex
```

Nếu trước đó bạn cài vào thư mục custom, set lại cùng thư mục trước:

```powershell
$env:KNOWNS_INSTALL_DIR = "$env:USERPROFILE\.knowns\bin"
irm https://knowns.sh/script/uninstall.ps1 | iex
```

## Go install

```bash
rm -f "$(go env GOPATH)/bin/knowns"
```

Nếu bạn tự tạo alias `kn`, hãy xóa alias đó luôn.

## Gỡ runtime memory adapters

Nếu đã bật runtime memory hooks cho assistant, gỡ adapter trước khi gỡ CLI:

```bash
knowns runtime uninstall codex
knowns runtime uninstall claude
knowns runtime uninstall opencode
knowns runtime uninstall kiro
```

Chỉ chạy các lệnh tương ứng với runtime bạn đã cấu hình.

## Những gì được giữ lại

Uninstall scripts chỉ xóa CLI binary và PATH entries do installer thêm. Các file sau được giữ nguyên có chủ ý:

- project `.knowns/` folders
- task, doc, spec, memory, decision, và template
- AI integration files đã generate như `AGENTS.md`, `CLAUDE.md`, `.agents/skills`, `.claude/skills`, `.mcp.json`, `.codex/config.toml`, hoặc `opencode.json`

Chỉ xóa thủ công các file đó khi bạn thật sự muốn bỏ project context hoặc remove AI integration artifacts khỏi repository.

## Kiểm tra đã gỡ xong

```bash
knowns --version
```

Nếu command not found, CLI đã được gỡ khỏi PATH hiện tại. Mở terminal mới nếu shell vẫn còn thấy PATH cũ.
