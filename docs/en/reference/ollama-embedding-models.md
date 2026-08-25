# Ollama Embedding Models

This page is the single prose source for semantic search's embedding guidance. Setup, `doctor`, and `init` all point here instead of repeating this advice, so the advice cannot drift between them — if you see different wording in a terminal message, that message links back to this page rather than replacing it.

Semantic search needs an embedding model to turn text into vectors. Knowns runs that model through [Ollama](https://ollama.com), a local runtime, or through any OpenAI-compatible embeddings API. Keyword (BM25) search never depends on either — it works the moment a project is initialized, with or without Ollama installed.

## Recommended models

Three Apache-2.0, Ollama-native models are seeded into every machine's global model registry (`~/.knowns/settings.json`) the first time Knowns reads it, so the first index has something to resolve against even on a brand-new machine.

| Model | Dimensions | Context | Tradeoff | Pull command |
| --- | --- | --- | --- | --- |
| `qwen3-embedding:0.6b` (default) | 1024 | 32,768 tokens | Best retrieval quality of the three; instruction-aware ranking; the largest and slowest to embed with | `ollama pull qwen3-embedding:0.6b` |
| `nomic-embed-text` | 768 | 8,192 tokens | Balanced middle ground — smaller and faster than the default, with far more context headroom than `all-minilm` | `ollama pull nomic-embed-text` |
| `all-minilm` | 384 | 256 tokens | Smallest and fastest; best for large corpora where indexing speed and RAM matter most, at the cost of truncating longer chunks and lower retrieval quality | `ollama pull all-minilm` |

`qwen3-embedding:0.6b` is the default used when `provider: ollama` is configured without a more specific model. Pick `nomic-embed-text` or `all-minilm` explicitly with `knowns config set semanticSearch.model <name>` if their tradeoff suits your project better.

## Install Ollama

1. Install Ollama from [ollama.com/download](https://ollama.com/download) (macOS, Linux, and Windows are all supported).
2. Start it — on macOS and Windows the installed app runs it for you; on Linux, or to run it manually, use `ollama serve`.
3. Pull the model you want with the command from the table above, for example:

   ```bash
   ollama pull qwen3-embedding:0.6b
   ```

4. Point a project at it:

   ```bash
   knowns config set semanticSearch.enabled true
   knowns config set semanticSearch.provider ollama
   knowns config set semanticSearch.model qwen3-embedding:0.6b
   knowns search --reindex
   ```

`knowns init` and `knowns settings` can do steps 3–4 interactively and will offer a model already on disk ahead of the default, but neither one pulls a model for you — a pull can be hundreds of megabytes, so it always requires an explicit `ollama pull`.

## Using a third-party OpenAI-compatible provider instead

No `api` provider is seeded by default: Ollama's local endpoint needs no credentials, while a third-party endpoint needs a URL and usually a key, so a placeholder entry would resolve and then fail at request time — worse than not existing at all. Register one yourself when you want to use a hosted embeddings API instead of a local Ollama model:

```bash
knowns provider add \
  --id openai \
  --name "OpenAI" \
  --api-base https://api.openai.com/v1 \
  --api-key sk-...

knowns config set semanticSearch.provider openai
knowns config set semanticSearch.model text-embedding-3-small
```

The model entry itself is added to `~/.knowns/settings.json` by hand, in the
shape shown below. Knowns preserves fields it does not recognise when it writes
that file, so a hand-added entry survives seeding and upgrades.

This writes an entry shaped like this into `~/.knowns/settings.json`:

```json
{
  "providers": {
    "openai": {
      "name": "OpenAI",
      "apiBase": "https://api.openai.com/v1",
      "apiKey": "sk-...",
      "timeout": 30,
      "batchSize": 64,
      "retry": { "maxRetries": 3, "initialDelay": 1000, "maxDelay": 30000 }
    }
  },
  "models": {
    "text-embedding-3-small": {
      "provider": "openai",
      "model": "text-embedding-3-small",
      "dimensions": 1536,
      "maxTokens": 8191
    }
  }
}
```

Any OpenAI-compatible embeddings endpoint works the same way — only `--api-base`, `--api-key`, the model name, and `dims`/`tokens` change.

## The four states

Setup, `doctor`, and `init` each detect one of four states and name a different next step for it. In every state except "ready," keyword search still works — semantic search degrading never takes search away.

| State | What it means | Next step | Keyword search |
| --- | --- | --- | --- |
| Ollama not installed | No Ollama binary or service answered at all | Install it from [ollama.com/download](https://ollama.com/download), then pull the model you want | Still works |
| Installed but not running | Ollama is present but not answering requests | Start it (`ollama serve`, or your platform's Ollama app), then pull the model if you haven't | Still works |
| Running, model missing | Ollama answers, but the configured model isn't pulled | Run `ollama pull <model>` for the model your project is configured to use | Still works |
| Ready | Ollama is running and the configured model is present | Nothing — semantic search is available | Works too |

If you only read one line from this page: install Ollama from [ollama.com/download](https://ollama.com/download), then run `ollama pull qwen3-embedding:0.6b`.

## Related pages

- [Semantic search](./semantic-search.md)
- [Configuration](./configuration.md)
