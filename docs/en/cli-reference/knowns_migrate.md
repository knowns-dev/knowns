# knowns migrate

Apply pending project config schema migrations

Preview or apply registered project config schema migrations.

Preview (no flags) reports what is pending and changes nothing. --write applies every pending migration in order and stamps the new schema version. There is no rollback subcommand: the config is in git, and git is the rollback.

## Usage

```
knowns migrate [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--write` | `bool` | — | Apply pending migrations and write the config |

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
