# Cấu hình

Knowns lưu project config trong `.knowns/config.json`.

File này khai báo những gì Knowns cần quản lý locally: platform integrations, semantic search, generated artifacts.

## Ví dụ

```json
{
  "name": "my-project",
  "settings": {
    "gitTrackingMode": "git-tracked",
    "gitTracking": {
      "tasks": true,
      "docs": true,
      "templates": true,
      "memories": false
    },
    "semanticSearch": {
      "enabled": true,
      "model": "multilingual-e5-small",
      "provider": "local",
      "dimensions": 384
    },
    "platforms": [
      "claude-code",
      "opencode",
      "codex",
      "kiro",
      "antigravity",
      "cursor",
      "gemini",
      "copilot",
      "agents"
    ],
    "lsp": {
      "enabled": true
    }
  }
}
```

## Các setting quan trọng

### `name`

Tên project hiển thị trong Knowns.

### `settings.gitTrackingMode`

- `git-tracked` — `.knowns/` content tracked trong Git
- `git-ignored` — config/docs/templates tracked, local data thì không
- `none` — Knowns không quản lý `.gitignore`

### `settings.gitTracking`

Per-section git tracking toggles. Kiểm soát subdirectories nào trong `.knowns/` được include/exclude trong `.gitignore`.

| Field | Default | Mô tả |
|-------|---------|-------|
| `tasks` | `true` | Track task markdown files |
| `docs` | `true` | Track documentation files |
| `templates` | `true` | Track code generation templates |
| `memories` | `false` | Track AI memory entries |

### `settings.semanticSearch`

Config cho local semantic search: `enabled`, `model`, `provider`, `dimensions`.

- `knowns init` set các giá trị này
- `knowns sync` re-apply semantic setup
- `knowns search --reindex` rebuild local index

### `settings.lsp`

Config cho LSP-based code intelligence.

- `enabled`: bật/tắt LSP servers cho code navigation

### `settings.platforms`

Khai báo platform integrations cần quản lý.

Supported: `claude-code`, `opencode`, `codex`, `kiro`, `antigravity`, `cursor`, `gemini`, `copilot`, `agents`.

Ảnh hưởng tới những gì `setup`, `sync`, `update` tạo hoặc refresh: instruction files, skills, MCP config, runtime hooks, platform-specific config.

## Khi nào edit config trực tiếp?

Có thể edit `.knowns/config.json` trực tiếp, nhưng flow thường là:

- `knowns init` cho lần đầu (project structure + git tracking)
- `knowns setup` cho AI platform integrations
- `knowns config set` để toggle features
- `knowns sync` để re-apply config

## Config toggle shorthands

```bash
# Interactive feature toggle UI
knowns config toggle
# Hiển thị:
#   AI Chat  [off]
#   LSP (Experimental)  [on]
#   Semantic Search  [on]
#   Done

# Hoặc set trực tiếp qua CLI
knowns config set embedding true       # Bật semantic search
knowns config set lsp true             # Bật LSP toàn cục
knowns config set lsp.go true          # Bật LSP cho Go
knowns config set enableChatUI true    # Bật chat UI

# Git Tracking (per-section)
knowns config set gitTracking.tasks true
knowns config set gitTracking.memories false
```

Thay đổi `gitTracking.*` sẽ tự động regenerate `.gitignore`.
