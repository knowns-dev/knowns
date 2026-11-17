# knowns decision restore

Restore a draft folded into a decision by the old link_as_related

Undo a fold: the rejected draft goes back to draft and the entries it shares with the --target decision are removed from the target. A pre-merge state is not stored, so this is a dry run by default that lists every shared entry as 'will remove'; compare with git log -p -- .knowns/decisions/<target file>, then re-run with --apply and one --keep <entry> for each entry the target owned. The @decision refs between the two stay as a plain link.

## Usage

```
knowns decision restore <draft-id> [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--apply` | `bool` | — | Write the restore instead of previewing it |
| `--keep` | `stringArray` | — | Entry to keep on the target (repeatable) |
| `--target` | `string` | — | Decision ID the draft was folded into |

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## See also

- [`knowns decision`](knowns_decision.md) — Manage System Decision records

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
