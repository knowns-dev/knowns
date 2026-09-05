# knowns template

Manage code generation templates

List, view, run, and create code generation templates.

## Usage

```
knowns template
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

- [`knowns template create`](knowns_template_create.md) — Create a new template scaffold
- [`knowns template list`](knowns_template_list.md) — List available templates
- [`knowns template run`](knowns_template_run.md) — Run a code generation template
- [`knowns template view`](knowns_template_view.md) — View template details

## See also

- [`knowns`](knowns.md) — The memory layer for AI-native software development

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
