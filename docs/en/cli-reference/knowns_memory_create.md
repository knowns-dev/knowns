# knowns memory create

Create a new memory entry

## Usage

```
knowns memory create <title> [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--category` | `string` | — | Memory category (pattern, convention, preference, failure); decision is legacy and rejected |
| `-c, --content` | `string` | — | Memory content |
| `--create-anyway` | `bool` | — | Create even when duplicate review candidates are found |
| `--layer` | `string` | — | Memory layer (working, project, global; default: project) |
| `--status` | `string` | — | Explicit memory status for human create/override |
| `-t, --tag` | `stringArray` | — | Memory tag (repeatable) |

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## See also

- [`knowns memory`](knowns_memory.md) — Manage memory entries

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
