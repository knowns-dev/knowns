# knowns eval retrieval

Evaluate retrieval and final ContextPack quality

## Usage

```
knowns eval retrieval [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--baseline` | `string` | — | Baseline file override (canonical runs only) |
| `--cases` | `string` | — | Project-local fixture path (report-only; never gates or updates canonical baselines) |
| `--mode` | `string` | `keyword` | Evaluation mode: keyword\|semantic\|hybrid |
| `--output` | `string` | — | Write the versioned JSON report to this explicit path |
| `--reason` | `string` | — | Review reason required with --update-baseline |
| `--runtime-id` | `string` | — | Pinned runtime/model identity required by semantic and hybrid evaluation |
| `--update-baseline` | `bool` | — | Explicitly replace a canonical baseline from the current reviewed result |

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--no-pager` | `bool` | — | Disable TUI pager (print styled output directly) |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## See also

- [`knowns eval`](knowns_eval.md) — Evaluate deterministic quality gates

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
