---
title: Model Command
createdAt: '2026-02-24T07:29:13.547Z'
updatedAt: '2026-02-24T07:29:40.821Z'
description: >-
  CLI command for managing embedding models - list, download, set, add custom
  models
tags:
  - feature
  - cli
  - model
  - embedding
  - search
---
# Model Command

Manage embedding models for semantic search.

## Overview

The `knowns model` command provides full control over embedding models used for semantic search. Models are stored globally at `~/.knowns/models/` and shared across all projects.

## Commands

### `knowns model` (Status)

Show current model status (shorthand for `knowns model status`).

```bash
knowns model
```

### `knowns model list`

List all available embedding models (built-in + custom).

```bash
knowns model list
knowns model ls  # Alias
```

**Output shows:**
- Model ID and name
- Quality tier (Fast, Balanced, Quality)
- HuggingFace ID
- Dimensions and max tokens
- Download status
- Recommended models marked with ★

### `knowns model download`

Download an embedding model.

```bash
knowns model download <model-id>
knowns model dl <model-id>  # Alias
```

**Built-in models:**

| Model ID | Quality | Dimensions | Size | Best For |
|----------|---------|------------|------|----------|
| `gte-small` ★ | Balanced | 384 | ~50MB | Most projects |
| `all-MiniLM-L6-v2` | Fast | 384 | ~45MB | Large codebases |
| `gte-base` | Quality | 768 | ~110MB | High accuracy |
| `bge-small-en-v1.5` | Balanced | 384 | ~50MB | English text |
| `bge-base-en-v1.5` | Quality | 768 | ~110MB | English, high quality |
| `e5-small-v2` | Balanced | 384 | ~50MB | General use |

### `knowns model set`

Set the embedding model for the current project.

```bash
knowns model set <model-id>
```

If the model is not downloaded, it will be downloaded automatically.

**After setting a new model:**
```bash
knowns search --reindex  # Rebuild search index
```

### `knowns model status`

Show detailed status of models and current project configuration.

```bash
knowns model status
```

**Output shows:**
- Global models directory location
- Number of downloaded models
- Total disk usage
- List of downloaded models with sizes
- Current project's model configuration

### `knowns model add`

Add a custom HuggingFace embedding model.

```bash
knowns model add <huggingface-id> [options]
```

| Option | Description |
|--------|-------------|
| `--dims <number>` | Embedding dimensions (default: 384) |
| `--tokens <number>` | Max input tokens (default: 512) |
| `--name <name>` | Display name for the model |

**Example:**
```bash
# Add a custom model
knowns model add Xenova/bge-large-en-v1.5 --dims 1024 --tokens 512

# Download and use it
knowns model download bge-large-en-v1.5
knowns model set bge-large-en-v1.5
knowns search --reindex
```

**Note:** The model must be a `feature-extraction` pipeline compatible with Transformers.js.

### `knowns model remove`

Remove a custom model.

```bash
knowns model remove <model-id>
knowns model rm <model-id>  # Alias
```

| Option | Description |
|--------|-------------|
| `-f, --force` | Also delete downloaded model files |

**Note:** Only custom models can be removed. Built-in models cannot be removed.

## Configuration

### Project Config

Model settings are stored in `.knowns/config.json`:

```json
{
  "settings": {
    "semanticSearch": {
      "enabled": true,
      "model": "gte-small",
      "huggingFaceId": "Xenova/gte-small",
      "dimensions": 384,
      "maxTokens": 512
    }
  }
}
```

### Custom Models

Custom models are stored in `~/.knowns/custom-models.json`:

```json
[
  {
    "id": "bge-large-en-v1.5",
    "huggingFaceId": "Xenova/bge-large-en-v1.5",
    "name": "BGE Large EN",
    "description": "Custom model from Xenova/bge-large-en-v1.5",
    "dimensions": 1024,
    "maxTokens": 512,
    "quality": "balanced",
    "custom": true
  }
]
```

### Model Storage

Models are downloaded to `~/.knowns/models/<huggingFaceId>/`:

```
~/.knowns/
├── models/
│   ├── Xenova/
│   │   ├── gte-small/
│   │   │   ├── config.json
│   │   │   ├── tokenizer.json
│   │   │   └── onnx/
│   │   │       └── model_quantized.onnx
│   │   └── gte-base/
│   │       └── ...
│   └── ...
└── custom-models.json
```

## Workflow Examples

### Setup semantic search on new project

```bash
# Initialize project with semantic search
knowns init
# ? Enable semantic search? Yes
# ? Select model: gte-small (recommended)

# Search works immediately
knowns search "authentication"
```

### Change model for better accuracy

```bash
# List available models
knowns model list

# Download and set higher quality model
knowns model download gte-base
knowns model set gte-base

# Rebuild index with new model
knowns search --reindex
```

### Add custom model for specific needs

```bash
# Add multilingual model
knowns model add Xenova/multilingual-e5-small --dims 384 --name "E5 Multilingual"

# Download and use
knowns model download multilingual-e5-small
knowns model set multilingual-e5-small
knowns search --reindex
```

## Related

- @doc/specs/semantic-search - Semantic search specification
- @doc/guides/cli-guide - CLI usage guide
