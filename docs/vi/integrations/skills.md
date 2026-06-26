# Skills

Skills là reusable workflow instructions, embedded trong Knowns binary và sync ra platform-specific directories.

Skills tách biệt với MCP tools. MCP tools hiện trong client dưới dạng structured domain tools như `tasks`, `docs`, `memory`, `search`, và `code`; skills được gọi bằng skill-command syntax của từng agent.

## Skill paths

- `.claude/skills` → Claude Code
- `.agents/skills` → OpenCode, Codex, Antigravity, Generic Agents
- `.kiro/skills` → Kiro

## Setup

Skills được tạo qua `knowns setup <target> --global` cho personal assistant setup thông thường, qua `knowns setup <target>` khi chủ ý muốn repo-local setup, hoặc re-sync bằng `knowns sync --skills`:

```bash
knowns setup claude --global    # Sync Claude skills/config ở user scope
knowns setup opencode --global  # Sync OpenCode skills/config ở user scope
knowns setup codex --global     # Sync Codex skills/config ở user scope
knowns setup kiro --global      # Sync Kiro skills/config ở user scope
knowns sync --skills   # Re-sync tất cả platforms đã cấu hình
```

## Invocation syntax

| Platform | Ví dụ |
|---|---|
| Claude Code | `/kn-spec`, `/kn-flow`, `/kn-review` |
| Codex | `$kn-spec`, `$kn-flow`, `$kn-review` |

Với SDD, approved-spec path được khuyến nghị là:

```text
Claude Code:
/kn-spec <feature-name>
/kn-flow @doc/<spec-path>

Codex:
$kn-spec <feature-name>
$kn-flow @doc/<spec-path>
$kn-flow @doc/<spec-path> --sequential # Opt out Codex sub-agent delegation
```

`kn-go` vẫn còn cho legacy no-review-gates pipeline. Dùng `kn-flow` cho normal approved-spec execution.

## Research behavior

`kn-research` là MCP-first:

- dùng Knowns `search`/`retrieve` cho project docs, tasks, memory, và decisions
- dùng Knowns `code` tools trước raw file search để xem code structure, symbols, definitions, và references
- dùng specialized external MCP providers như Context7/library docs, GitHub/source MCP, hoặc official docs MCP khi cần upstream facts
- dùng general web search chỉ khi specialized MCP providers không có, không đủ, hoặc user yêu cầu rõ

Khi research scope lớn và runtime expose sub-agent tools, `kn-research` có thể tách các track độc lập cho sub-agents. External results chỉ là supporting evidence, không thay thế local docs, tasks, source files, hoặc user instructions.

## Ghi chú

- `.agents/skills` là primary path cho agent-compatible platforms
- `knowns init` không còn sync skills — dùng `knowns setup <target> --global` sau init cho personal assistant setup
- `knowns sync --skills` là entrypoint để regenerate skills sau khi update
