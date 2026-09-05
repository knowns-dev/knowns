# knowns status

Show project readiness summary

Display a unified readiness summary for the active Knowns project.

Shows project identity, knowledge counts, search status, runtime health,
and available capabilities in one view.

Use --json for structured output consumed by scripts or AI clients.
Use --plain for clean text output suitable for piping.

## Usage

```
knowns status
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
