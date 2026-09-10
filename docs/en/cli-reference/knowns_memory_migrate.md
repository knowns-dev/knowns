# knowns memory migrate

Freeze the claim boundary of memories the system is guessing at

Injection shows only a memory's claim. When an entry carries no <!--memory:detail--> the claim is taken from the first paragraph, which is a guess nobody made deliberately and which a later edit to the opening paragraph can move without anyone noticing.

Without flags this previews the entries in that state. --write inserts the marker exactly where the split happens today, so what gets injected does not change; only who decided it does.

## Usage

```
knowns memory migrate [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--all-statuses` | `bool` | — | Include non-active memory statuses |
| `--layer` | `string` | — | Limit to one layer: project or global (default: both) |
| `--write` | `bool` | — | Insert the marker instead of only previewing |

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## See also

- [`knowns memory`](knowns_memory.md) — Manage memory entries

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
