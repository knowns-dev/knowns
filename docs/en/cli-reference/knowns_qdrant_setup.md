# knowns qdrant setup

Detect and set up a Qdrant for semantic search on this machine

Detect what can serve Qdrant on this machine and set it up.

In priority order: a Qdrant that already answers (KNOWNS_QDRANT_URL, the endpoint
recorded for this machine, or 127.0.0.1:6333), managed Qdrant when this platform
has a pinned build, then Docker. It asks only when more than one option works;
--yes, --json or a non-interactive terminal take the first one.

The choice is recorded for this machine under ~/.knowns/runtime/qdrant and
outranks the project config; the project's .knowns/config.json is not changed.

## Usage

```
knowns qdrant setup [flags]
```

## Examples

```bash
knowns qdrant setup
  knowns qdrant setup --yes
  knowns qdrant setup --url http://qdrant.internal:6333
  knowns qdrant setup --docker --yes
  knowns qdrant setup --remove
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--docker` | `bool` | — | Run Qdrant in Docker (container knowns-qdrant) |
| `--managed` | `bool` | — | Use managed Qdrant |
| `--now` | `bool` | — | With managed Qdrant, install and start it now |
| `--remove` | `bool` | — | Remove what setup recorded for this machine (and its Docker container) |
| `--url` | `string` | — | Use the Qdrant at this endpoint |
| `--volume` | `bool` | — | With --remove, also remove the Docker volume holding the vectors |
| `-y, --yes` | `bool` | — | Take the first valid option without asking |

## Inherited flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | `bool` | — | JSON output |
| `--page` | `int` | `0` | Page number for paginated output (e.g. --page 2) |
| `--page-size` | `int` | `0` | Lines per page (default 50) |
| `--plain` | `bool` | — | Plain text output (for AI agents) |

## See also

- [`knowns qdrant`](knowns_qdrant.md) — Inspect and control the semantic Qdrant runtime

---

Generated from the command tree by `make cli-docs`. Do not edit by hand.
