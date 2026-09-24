# knowns doc create

Create a new documentation file

## Usage

```
knowns doc create <title> [flags]
```

## Examples

```bash
# A core doc, at the root of .knowns/docs/
  knowns doc create "ARCHITECTURE" -d "System design"

  # A categorized doc, -f names the folder
  knowns doc create "Controller Pattern" -f patterns -t pattern,backend
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `-c, --content` | `string` | — | Initial content |
| `-d, --description` | `string` | — | Document description |
| `-f, --folder` | `string` | — | Folder path within docs/ |
| `-t, --tag` | `stringArray` | — | Document tag (repeatable) |

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## See also

- [`knowns doc`](knowns_doc.md) — Manage documentation

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
