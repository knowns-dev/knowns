# knowns doc view

View a documentation file

## Usage

```
knowns doc view <path> [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--info` | `bool` | — | Show document stats without content |
| `--line` | `string` | — | Show specific lines (e.g., '42' or '10-20') |
| `--section` | `string` | — | Show specific section by number or title |
| `--smart` | `bool` | — | Auto-optimize reading for large documents |
| `--toc` | `bool` | — | Show table of contents only |

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
