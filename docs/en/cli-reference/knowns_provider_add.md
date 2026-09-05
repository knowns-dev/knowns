# knowns provider add

Register a new embedding provider

Register an OpenAI-compatible embedding API provider. Tests connectivity before saving.

## Usage

```
knowns provider add [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--api-base` | `string` | — | API base URL (e.g., http://localhost:11434/v1) |
| `--api-key` | `string` | — | API key (optional for local providers) |
| `--id` | `string` | — | Provider ID (e.g., ollama, openai) |
| `--name` | `string` | — | Display name |

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## See also

- [`knowns provider`](knowns_provider.md) — Manage embedding API providers

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
