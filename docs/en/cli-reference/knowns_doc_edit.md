# knowns doc edit

Edit a documentation file

## Usage

```
knowns doc edit <path> [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `-a, --append` | `string` | — | Append to content |
| `-c, --content` | `string` | — | Replace content |
| `-d, --description` | `string` | — | New description |
| `--expected-hash` | `string` | — | Expected canonical hash for optimistic concurrency |
| `--path` | `string` | — | Rename doc to a new path |
| `--section` | `string` | — | Target section to replace (used with --content) |
| `--tags` | `string` | — | New tags (comma-separated) |
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

- [`knowns doc`](knowns_doc.md) — Manage documentation

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
