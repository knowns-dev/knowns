# knowns decision migrate apply

Apply one explicit reviewed migration resolution

## Usage

```
knowns decision migrate apply [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--accept-verified` | `bool` | — | Accept only if linked evidence passes System Decision verification |
| `--category` | `string` | — | Non-decision Memory category for reclassification |
| `--decision-id` | `string` | — | Existing or explicit System Decision ID |
| `--doc` | `stringArray` | — | Related doc path for created/linked Decision (repeatable) |
| `--memory` | `string` | — | Legacy Decision Memory ID (required) |
| `--reason` | `string` | — | Reviewed archive/reject rationale |
| `--resolution` | `string` | — | Reviewed resolution: create_decision, link_existing, consolidate_duplicate, reclassify, archive_noise, reject_noise, leave_unchanged |
| `--target-memory` | `string` | — | Migrated target Memory ID for duplicate consolidation |
| `--task` | `stringArray` | — | Related completed task for verified acceptance (repeatable) |

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## See also

- [`knowns decision migrate`](knowns_decision_migrate.md) — Review and migrate legacy Decision Memories

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
