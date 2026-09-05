# knowns agents

Manage agent instruction files

Manage AI agent instruction files
(CLAUDE.md, OPENCODE.md, GEMINI.md, AGENTS.md,
.github/copilot-instructions.md).

Shows the status of instruction files for each supported AI platform and
can sync/generate them from project configuration.

## Usage

```
knowns agents
```

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## See also

- [`knowns`](knowns.md) — The memory layer for AI-native software development

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
