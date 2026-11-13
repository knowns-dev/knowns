# knowns store resolve

Settle conflicting changes that paused a project's sync

Without arguments, list projects paused by a conflict and their conflicting
entities. With a project, show the version in the store's history (remote) and
the version on this machine (local) for each conflicting path, or for the paths
given. With --keep, apply that choice to each of them and let sync resume:

  local   keep this machine's version; it is pushed once sync resumes
  remote  keep the version already in the store
  both    keep this machine's version in place and save the remote version
          beside the runtime state

Nothing is discarded without an explicit --keep.

## Usage

```
knowns store resolve [project] [path...] [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--keep` | `string` | — | Version to keep for each conflicting entity: local, remote or both |
| `--store` | `string` | — | Store name, when the project folder name exists in more than one store |

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
