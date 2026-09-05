# knowns decision

Manage System Decision records

Create draft System Decisions, link evidence, verify acceptance, supersede current guidance, and migrate Legacy Decision Memories.

## Usage

```
knowns decision
```

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## Subcommands

- [`knowns decision accept`](knowns_decision_accept.md) — Accept a verified draft decision
- [`knowns decision create`](knowns_decision_create.md) — Create a decision record
- [`knowns decision get`](knowns_decision_get.md) — View a decision record
- [`knowns decision inbox`](knowns_decision_inbox.md) — List unresolved persisted Decision candidates
- [`knowns decision link`](knowns_decision_link.md) — Link docs, tasks, or sources to a decision
- [`knowns decision list`](knowns_decision_list.md) — List decision records
- [`knowns decision migrate`](knowns_decision_migrate.md) — Review and migrate legacy Decision Memories
- [`knowns decision resolve`](knowns_decision_resolve.md) — Resolve a persisted System Decision candidate
- [`knowns decision supersede`](knowns_decision_supersede.md) — Mark one decision as superseded by another

## See also

- [`knowns`](knowns.md) — The memory layer for AI-native software development

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
