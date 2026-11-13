# knowns store link

Link this repository to a knowledge store

Link the current code repository to a project folder in a store: a Git
repository that holds the knowledge of one or more projects.

The store is cloned into ~/.knowns/stores/<store>/ when it is not already
present, the project folder is created or adopted, and the link is recorded
in ~/.knowns/registry.json. No file is written into the code repository.

Git uses your existing ssh-agent or credential helper; Knowns never stores a
credential and never prompts.

## Usage

```
knowns store link <remote> [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--as` | `string` | — | Project folder name in the store (default: current directory name) |
| `--migrate` | `bool` | — | Copy this repository's .knowns/ into the store folder, keeping every ID; the repository is left untouched |
| `--store` | `string` | — | Store folder name under ~/.knowns/stores (default: derived from the remote) |

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## See also

- [`knowns store`](knowns_store.md) — Keep project knowledge in a shared Git store instead of the repository

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
