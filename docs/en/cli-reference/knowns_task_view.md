# knowns task view

View a task

## Usage

```
knowns task view <id>
```

## Examples

```bash
# Full task, styled
  knowns task view KN-A1B2C3

  # The same thing, since view is optional
  knowns task KN-A1B2C3

  # Parseable output for an agent
  knowns task KN-A1B2C3 --plain
```

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## See also

- [`knowns task`](knowns_task.md) — Manage tasks

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
