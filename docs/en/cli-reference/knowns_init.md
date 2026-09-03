# knowns init

Initialize a new Knowns project

Initialize a new Knowns project in the current directory.
Creates a .knowns/ directory with the required structure and a default config.json.

## Usage

```
knowns init [name] [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `-f, --force` | `bool` | — | Force reinitialize even if already initialized |
| `--git-ignored` | `bool` | — | Add .knowns/ to .gitignore |
| `--git-tracked` | `bool` | — | Track .knowns/ files in git |
| `--no-open` | `bool` | — | Skip the web UI launch prompt after init |
| `--no-wizard` | `bool` | — | Skip interactive prompts, use defaults |
| `--open` | `bool` | — | Launch the web UI immediately after init |
| `--task-prefix` | `string` | — | Default task ID prefix (2-8 alphanumeric characters, e.g. KN) |
| `--wizard` | `bool` | — | Run interactive setup wizard |

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
