# External Qdrant

Semantic search stores its vectors in [Qdrant](https://qdrant.tech). Knowns can
either run Qdrant for you or connect to one you already run.

| Mode | What Knowns does | Endpoint |
|---|---|---|
| `managed` (default) | Downloads a pinned Qdrant binary, starts and stops the process, owns its data directory | `http://127.0.0.1:6333`, fixed |
| `external` | Connects over HTTP only. Never installs, starts, stops, or cleans up a process | Whatever you configure |

Managed mode is the default and needs no setup. This page is about external mode.

## When you need external mode

- The managed binary does not run on your platform. Knowns pins Qdrant 1.14.1
  for `darwin/arm64`, `darwin/amd64`, `linux/amd64`, and `linux/arm64` only. The
  `linux/amd64` build is linked against glibc, so it will not run on a musl
  distribution such as Alpine.
- You already run Qdrant, in Docker or as a shared service, and want one
  instance instead of one per machine.
- You run Knowns in a container and do not want a second long-lived process
  inside it.
- You want Qdrant on a host you control, with your own backups and TLS.

If managed mode works for you, stay on it. External mode gives you the
endpoint and hands you the operational work that comes with it.

## Setup

### Option A: environment variable

The fastest route. Setting the URL is enough, because it implies external mode
on its own.

```bash
export KNOWNS_QDRANT_URL=https://qdrant.example.com:6333
export KNOWNS_QDRANT_API_KEY=<your key>
```

Nothing is written to the project. This is the right form for CI, containers,
and for trying external mode before committing to it.

### Option B: project config

Persist it in `.knowns/config.json` when the whole team should use the same
endpoint.

**Set the URL before the mode.** Config is validated on every write, and
`mode: external` without a URL is rejected.

```bash
knowns config set settings.semanticSearch.vectorStore.externalURL "https://qdrant.example.com:6333"
knowns config set settings.semanticSearch.vectorStore.mode external
```

Resulting block:

```json
{
  "settings": {
    "semanticSearch": {
      "enabled": true,
      "model": "qwen3-embedding:0.6b",
      "provider": "ollama",
      "vectorStore": {
        "backend": "qdrant",
        "mode": "external",
        "externalURL": "https://qdrant.example.com:6333"
      }
    }
  }
}
```

The API key is never part of this file. It comes from the environment only.

### Running Qdrant yourself

The official image covers both amd64 and arm64:

```bash
docker run -d --name knowns-qdrant \
  -p 127.0.0.1:6333:6333 \
  -v qdrant_storage:/qdrant/storage \
  qdrant/qdrant:v1.14.1
```

Then point Knowns at it:

```bash
export KNOWNS_QDRANT_URL=http://127.0.0.1:6333
```

Binding to `127.0.0.1` rather than `0.0.0.0` matters: it keeps the endpoint on
loopback, which is the only case where plain HTTP is accepted.

### Build the index

The collection lives on the server, so a fresh endpoint has nothing in it. The
old pointer still refers to a collection that is not there.

```bash
knowns search index --wait
```

## Requirements

| Rule | Detail |
|---|---|
| HTTPS outside loopback | Plain `http://` is accepted only for `localhost`, `127.0.0.1`, and `::1`. Every other host must use `https://`, with normal certificate verification. |
| No secrets in the URL | The URL must not carry user info, a query string, or a fragment. |
| API key from the environment | `KNOWNS_QDRANT_API_KEY` only. It is sent as Qdrant's `api-key` header and is never written to project config, the pointer file, status output, doctor evidence, or logs. |

The HTTPS rule is the one that catches people. If Knowns runs in one container
and Qdrant in another, `http://qdrant:6333` over the Docker network **will be
rejected**, because `qdrant` is not a loopback host. Either put both on the same
network namespace and use `127.0.0.1`, or terminate TLS in front of Qdrant.

## Verify

```bash
knowns qdrant status --plain
```

External mode reports:

```text
state       external
backend     qdrant
mode        external
managed     false
externalURL https://qdrant.example.com:6333
message     external Qdrant URL configured; managed process ownership disabled
```

Then check search readiness:

```bash
knowns doctor --scope search
```

## What changes in external mode

- `knowns qdrant install`, `start`, and `stop` no longer apply. `install`
  returns an error; `start` and `stop` report that they were bypassed. Starting
  and stopping the server is yours to do.
- `knowns doctor` does not probe the endpoint. It reports the collection check
  as a warning saying so, rather than pretending to have verified a server it
  did not contact. Verify the endpoint and collection yourself.
- Collection cleanup is conservative. Old generations are only deleted when this
  store's own pointer and generation history prove ownership. Anything else is
  reported as a candidate and left alone, so Knowns never deletes a collection
  on a shared server that it cannot prove it created.
- Upgrades are yours. Nothing pins the server version for you.

## Troubleshooting

| Message | Cause | Fix |
|---|---|---|
| `non-loopback Qdrant endpoints require HTTPS` | `http://` with a host that is not loopback | Use `https://`, or reach the server on `127.0.0.1` |
| `qdrant url must not contain credentials, query secrets, or fragments` | Key or token embedded in the URL | Remove it and use `KNOWNS_QDRANT_API_KEY` |
| `mode "external" requires externalURL` | `mode` was set before the URL | Set `externalURL` first, then `mode` |
| `qdrant install applies only to managed mode` | `knowns qdrant install` in external mode | Expected. Nothing to install |
| `qdrant pointer missing; run: knowns search index --wait` | New endpoint has no collection yet | Run `knowns search index --wait` |
| `unsupported Qdrant platform <os>/<arch>` | No managed binary for this platform | This page is the answer. Configure an external endpoint |

## Going back to managed mode

```bash
knowns config set settings.semanticSearch.vectorStore.mode managed
knowns qdrant install
knowns search index --wait
```

Unset `KNOWNS_QDRANT_URL` too, if it is set. It overrides project config and
forces external mode on its own.

## Environment variables

| Variable | Purpose |
|---|---|
| `KNOWNS_QDRANT_URL` | External endpoint. Implies `mode: external` |
| `KNOWNS_SEMANTIC_QDRANT_URL` | Alias for the above |
| `KNOWNS_QDRANT_API_KEY` | API key sent as the `api-key` header |
| `KNOWNS_SEMANTIC_VECTOR_MODE` | `managed` or `external` |
| `KNOWNS_SEMANTIC_VECTOR_BACKEND` | `qdrant`, `sqlite`, or `none` |
| `KNOWNS_SEMANTIC_VECTOR_ENABLED` | Turns semantic vector search on or off |
| `KNOWNS_SEMANTIC_VECTOR_MANAGED_ROOT` | Managed runtime root, default `~/.knowns/runtime/qdrant` |
| `KNOWNS_QDRANT_MIRROR` | Alternate download host for the managed binary. Checksum verification is unchanged |

Environment beats project config, which beats global settings, which beats
defaults.

## See also

- [Semantic search](./semantic-search.md)
- [Configuration](./configuration.md)
- [Ollama Embedding Models](./ollama-embedding-models.md)
