---
title: OpenAI-Compatible Embedding Provider
description: Specification for adding OpenAI-compatible embedding API support (Ollama, OpenAI, Azure, LM Studio, etc.) as an alternative to local ONNX inference
createdAt: '2026-05-07T03:13:20.324Z'
updatedAt: '2026-05-07T03:16:38.989Z'
tags:
  - spec
  - approved
  - embedding
  - api
  - search
---

# OpenAI-Compatible Embedding Provider

## Overview

Add support for OpenAI-compatible embedding APIs as an alternative to the current local ONNX inference. A single HTTP client implementation covers all providers that expose the `/v1/embeddings` endpoint: Ollama (local), OpenAI, Azure OpenAI, LM Studio, vLLM, LocalAI, and any self-hosted server.

This preserves the existing local ONNX path as the default while giving users the option to use larger/better models via API providers.

## Locked Decisions

- D1: Use OpenAI-compatible `/v1/embeddings` API — one client covers all providers
- D2: Separate provider and model config, stored in `~/.knowns/settings.json`
- D3: Providers have IDs that projects reference via `.knowns/config.json`
- D4: Auto-detect Ollama via HTTP API (`/api/version`, `/api/tags`, `/api/show`) — no CLI exec
- D5: Graceful fallback to keyword-only search when API is unreachable
- D6: Auto-reindex when model changes (dimensions mismatch triggers full reindex)
- D7: Retry with configurable exponential backoff on HTTP 429
- D8: `knowns provider add/list/remove` as top-level CLI command

## Requirements

### Functional Requirements

- FR-1: Support embedding via any OpenAI-compatible `/v1/embeddings` endpoint
- FR-2: Provider registry in `~/.knowns/settings.json` with unique IDs per provider
- FR-3: Model definitions reference a provider ID and specify model name + dimensions
- FR-4: Project config references a model ID from the global registry
- FR-5: Auto-detect running Ollama instance and list available embedding models
- FR-6: `knowns provider add` — register a new provider (interactive or flags)
- FR-7: `knowns provider list` — show registered providers with connection status
- FR-8: `knowns provider remove` — remove a provider by ID
- FR-9: `knowns model add` extended to support API-backed models (provider + model name)
- FR-10: `knowns init` offers API provider as embedding source option
- FR-11: `knowns sync` verifies API provider reachability and model availability
- FR-12: Automatic reindex when switching to a model with different dimensions
- FR-13: Retry with exponential backoff on HTTP 429 (rate limit) responses
- FR-14: Batch embedding support — send multiple texts per API call

### Non-Functional Requirements

- NFR-1: Existing local ONNX path remains default and unchanged
- NFR-2: No new external dependencies for the HTTP client (use Go stdlib `net/http`)
- NFR-3: API key stored in `~/.knowns/settings.json` (not in project config, not committed)
- NFR-4: Timeout configurable per provider (default: 30s per request)
- NFR-5: Batch size configurable per provider (default: 64 texts per request)
- NFR-6: Graceful degradation — never crash if provider is unavailable

## Configuration Schema

### Global: `~/.knowns/settings.json`

```json
{
  "embeddingProviders": {
    "ollama": {
      "name": "Ollama Local",
      "apiBase": "http://localhost:11434/v1",
      "apiKey": "",
      "timeout": 30,
      "batchSize": 64,
      "retry": {
        "maxRetries": 3,
        "initialDelay": 1000,
        "maxDelay": 30000
      }
    },
    "openai": {
      "name": "OpenAI",
      "apiBase": "https://api.openai.com/v1",
      "apiKey": "sk-...",
      "timeout": 60,
      "batchSize": 128,
      "retry": {
        "maxRetries": 5,
        "initialDelay": 2000,
        "maxDelay": 60000
      }
    }
  },
  "embeddingModels": {
    "nomic-embed": {
      "provider": "ollama",
      "model": "nomic-embed-text",
      "dimensions": 768
    },
    "openai-small": {
      "provider": "openai",
      "model": "text-embedding-3-small",
      "dimensions": 1536
    }
  },
  "defaultEmbeddingModel": "nomic-embed"
}
```

### Project: `.knowns/config.json`

```json
{
  "settings": {
    "semanticSearch": {
      "enabled": true,
      "provider": "api",
      "model": "nomic-embed"
    }
  }
}
```

When `provider` is `"api"`, the system looks up the model ID in `~/.knowns/settings.json`. When `provider` is omitted or `"local"`, the existing ONNX path is used.

## Acceptance Criteria

- [ ] AC-1: `knowns provider add` tests connectivity before saving; fails without saving if unreachable
- [ ] AC-2: `knowns provider list` shows all providers with reachability status (✓/✗)
- [ ] AC-3: `knowns provider remove <id>` removes provider; fails if models still reference it
- [ ] AC-4: `knowns provider test <id>` health-checks a saved provider and reports status
- [ ] AC-5: Embedding via `/v1/embeddings` produces correct vectors (verified against known model output)
- [ ] AC-6: Batch embedding sends multiple texts per request up to configured `batchSize`
- [ ] AC-7: HTTP 429 triggers exponential backoff retry up to `maxRetries`
- [ ] AC-8: Unreachable provider falls back to keyword-only search with warning
- [ ] AC-9: `knowns init` detects running Ollama and offers only embedding-capable models
- [ ] AC-10: `knowns sync` verifies provider + model availability; warns if unreachable
- [ ] AC-11: Changing model with different dimensions triggers automatic reindex
- [ ] AC-12: Existing local ONNX embedding continues to work unchanged
- [ ] AC-13: API key is never written to project-level config or committed to git
- [ ] AC-14: `knowns model add` with API provider auto-detects dimensions via test embed; `--dims` flag overrides
## Scenarios

### Scenario 1: Fresh Setup with Ollama

**Given** Ollama is running locally with `nomic-embed-text` pulled
**When** user runs `knowns init` and selects "API Provider"
**Then** system auto-detects Ollama, lists available embedding models, user picks one, provider + model registered in `~/.knowns/settings.json`, project config set to use it

### Scenario 2: Add OpenAI Provider

**Given** user has OpenAI API key
**When** user runs `knowns provider add --id openai --api-base https://api.openai.com/v1 --api-key sk-...`
**Then** provider registered, connectivity verified, success message shown

### Scenario 3: Switch Model (Different Dimensions)

**Given** project uses `nomic-embed` (768d)
**When** user runs `knowns model set openai-small` (1536d)
**Then** config updated, dimensions mismatch detected, automatic reindex triggered with progress output

### Scenario 4: Provider Unreachable

**Given** project configured with API provider, Ollama not running
**When** user runs `knowns search "query"`
**Then** warning printed ("Provider 'ollama' unreachable, falling back to keyword-only"), keyword search results returned

### Scenario 5: Rate Limited

**Given** project uses OpenAI provider during large reindex
**When** API returns HTTP 429
**Then** system retries with exponential backoff (1s, 2s, 4s...), continues reindex after successful retry

### Scenario 6: Clone Repo with API Provider Config

**Given** repo has `.knowns/config.json` with `"provider": "api", "model": "nomic-embed"`
**When** user runs `knowns sync` on new machine
**Then** system checks `~/.knowns/settings.json` for model "nomic-embed", if not found prompts user to configure provider

### Scenario 7: Ollama Auto-Detection During Init

**Given** Ollama running at default port with multiple models
**When** `knowns init` reaches embedding source selection
**Then** system calls `GET /api/version` (confirms running), `GET /api/tags` (lists models), filters embedding-capable models, shows them as options with dimensions from `POST /api/show`

## Technical Notes

### OpenAI Embeddings API Contract

```
POST {apiBase}/embeddings
Authorization: Bearer {apiKey}
Content-Type: application/json

{
  "model": "nomic-embed-text",
  "input": ["text 1", "text 2"]
}

Response:
{
  "object": "list",
  "data": [
    { "object": "embedding", "index": 0, "embedding": [0.1, 0.2, ...] }
  ],
  "model": "nomic-embed-text",
  "usage": { "prompt_tokens": 12, "total_tokens": 12 }
}
```

### Ollama Detection APIs

```
GET /api/version → { "version": "0.6.2" }
GET /api/tags → { "models": [{ "name": "nomic-embed-text:latest", ... }] }
POST /api/show { "name": "nomic-embed-text" } → { "model_info": { "embedding_length": 768 } }
```

### Architecture Integration

The existing `Embedder` struct in `internal/search/embedding_native.go` is tightly coupled to `ORTRuntime`. The new API embedder should implement the same interface pattern:

```go
// New: internal/search/embedding_api.go
type APIEmbedder struct {
    client     *http.Client
    config     APIEmbedderConfig
    retryOpts  RetryConfig
}

func (e *APIEmbedder) Embed(text string) ([]float32, error)
func (e *APIEmbedder) EmbedDocument(text string) ([]float32, error)
func (e *APIEmbedder) EmbedQuery(text string) ([]float32, error)
func (e *APIEmbedder) EmbedBatch(texts []string) ([][]float32, error)
func (e *APIEmbedder) EmbedDocumentBatch(texts []string) ([][]float32, error)
func (e *APIEmbedder) EmbedQueryBatch(texts []string) ([][]float32, error)
func (e *APIEmbedder) Dimensions() int
func (e *APIEmbedder) Close()
```

`InitSemantic()` in `internal/search/init.go` should branch based on config: if `provider == "api"` → create `APIEmbedder`, else → create `Embedder` (ONNX).

### Batch Strategy for API

- Sort texts by length (same optimization as ONNX path)
- Split into chunks of `batchSize`
- Send each chunk as one API call
- Collect results in order

## Open Questions

All resolved:

- [x] `knowns provider add` auto-detects dimensions via test embed call; `--dims` flag available as override → both supported
- [x] Yes — `knowns provider test <id>` command for health checking. Also `knowns provider add` tests before saving (fail = don't save)
- [x] Ollama detection filters to embedding-capable models only (not chat/generation models)
