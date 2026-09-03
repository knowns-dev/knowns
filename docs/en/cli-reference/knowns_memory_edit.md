# knowns memory edit

Edit a memory entry

## Usage

```
knowns memory edit <id> [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `-a, --append` | `string` | — | Append to content |
| `--category` | `string` | — | New category |
| `-c, --content` | `string` | — | Replace content |
| `--tag` | `stringArray` | — | New tags (replaces existing) |
| `-t, --title` | `string` | — | New title |

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
