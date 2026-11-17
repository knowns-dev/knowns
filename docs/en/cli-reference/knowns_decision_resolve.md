# knowns decision resolve

Resolve a persisted System Decision candidate

Resolve a persisted candidate with accept_new, accept_distinct, link_as_related, merge_duplicate, reject_new, or supersede_existing. link_as_related only links the two decisions (both keep their status). merge_duplicate folds the draft into the target and rejects the draft. Link, merge and replace require --target. accept_distinct accepts a draft whose matches are not duplicates, keeps the matched decisions current, and requires --reason (recorded on the accepted decision). It is a human-gated operation like accept_new.

## Usage

```
knowns decision resolve <resolution> <candidate-id> [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--reason` | `string` | — | Reviewer reason, required by accept_distinct |
| `--replacement-id` | `string` | — | Existing verified replacement Decision ID for supersede_existing |
| `--target` | `string` | — | Existing Decision ID required by link_as_related, merge_duplicate or supersede_existing |

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
