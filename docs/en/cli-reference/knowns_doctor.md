# knowns doctor

Diagnose project and local integration health

Run read-only diagnostics for the active Knowns project.

Every applicable check runs, including bounded probes of the configured
embedding provider. Use --scope to select diagnostic areas and --verbose to
show passing and skipped checks.

## Usage

```
knowns doctor [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--scope` | `stringSlice` | — | Diagnostic scope (repeatable or comma-separated) |
| `--strict` | `bool` | — | Return exit code 1 when the verdict is degraded |
| `--verbose` | `bool` | — | Show passing and skipped checks |

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
