# knowns validate

Validate tasks, docs, and templates

## Usage

```
knowns validate [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--entity` | `string` | — | Validate a specific entity (task ID or doc path) |
| `--fix` | `bool` | — | Auto-fix supported issues |
| `--scope` | `string` | `all` | Validation scope: all\|tasks\|docs\|templates\|sdd |
| `--strict` | `bool` | — | Treat warnings as errors |

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
