// Port of internal/storage/embedding_registry_defaults.go and semantic_resolve.go: the D2
// Ollama embedding models seeded into every user's registry, the Ollama guidance text, and the
// in-memory resolution of `provider: local` to the D2 default.
import type { SemanticSearchSettings } from "../../models/config.ts";
import type {
  EmbeddingModel,
  EmbeddingProvider,
  EmbeddingSettings,
} from "./embedding-settings-store.ts";

export const OLLAMA_PROVIDER_ID = "ollama";
export const OLLAMA_HOST_BASE = "http://localhost:11434";
export const OLLAMA_GUIDANCE_DOCS_URL = "https://knowns.sh/docs";
const OLLAMA_PROVIDER_API_BASE = `${OLLAMA_HOST_BASE}/v1`;
export const OLLAMA_INSTALL_URL = "https://ollama.com/download";

export interface D2ModelDefinition {
  id: string;
  default?: boolean;
  model: EmbeddingModel;
  tradeoff: string;
}

export function pullCommandFor(modelId: string): string {
  return `ollama pull ${modelId}`;
}

export const D2_MODELS: readonly D2ModelDefinition[] = [
  {
    id: "qwen3-embedding:0.6b",
    default: true,
    model: {
      provider: OLLAMA_PROVIDER_ID,
      model: "qwen3-embedding:0.6b",
      dimensions: 1024,
      maxTokens: 32768,
      queryPrefix:
        "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ",
    },
    tradeoff:
      "Best retrieval quality of the three: 1024 dimensions and a 32k-token context window, instruction-aware for better ranking. The largest and slowest of the three to embed with \u2014 the default because quality matters more than speed for most projects.",
  },
  {
    id: "nomic-embed-text",
    model: {
      provider: OLLAMA_PROVIDER_ID,
      model: "nomic-embed-text",
      dimensions: 768,
      maxTokens: 8192,
      queryPrefix: "search_query: ",
      docPrefix: "search_document: ",
    },
    tradeoff:
      "Balanced middle ground: 768 dimensions and an 8192-token context window \u2014 smaller and faster than qwen3-embedding:0.6b, with far more context headroom than all-minilm for long documents.",
  },
  {
    id: "all-minilm",
    model: {
      provider: OLLAMA_PROVIDER_ID,
      model: "all-minilm",
      dimensions: 384,
      maxTokens: 256,
    },
    tradeoff:
      "Smallest and fastest of the three: 384 dimensions and only a 256-token context window per chunk. Best for large corpora where indexing speed and RAM matter most, at the cost of truncating longer chunks and lower retrieval quality.",
  },
];

function findDefault(): D2ModelDefinition {
  const d = D2_MODELS.find((m) => m.default);
  if (!d) throw new Error("storage: D2Models has no entry marked Default");
  return d;
}

/** D2DefaultModelID: registry key of the D2 default model. */
export const D2_DEFAULT_MODEL_ID: string = findDefault().id;

export interface ModelGuidance {
  id: string;
  default: boolean;
  dimensions: number;
  maxTokens: number;
  tradeoff: string;
  installLocation: string;
  pullCommand: string;
}

/** RecommendedModels: FR-9 per-model guidance rendered from D2_MODELS. */
export function recommendedModels(): ModelGuidance[] {
  return D2_MODELS.map((m) => ({
    id: m.id,
    default: m.default === true,
    dimensions: m.model.dimensions,
    maxTokens: m.model.maxTokens ?? 0,
    tradeoff: m.tradeoff,
    installLocation: OLLAMA_INSTALL_URL,
    pullCommand: pullCommandFor(m.id),
  }));
}

export const OllamaState = {
  NotInstalled: 0,
  NotRunning: 1,
  ModelMissing: 2,
  Ready: 3,
} as const;
export type OllamaState = (typeof OllamaState)[keyof typeof OllamaState];

const KEYWORD_SEARCH_STILL_WORKS = "Keyword search still works without it.";

export interface OllamaGuidance {
  description: string;
  command: string;
}

/** OllamaStateGuidance: FR-10/FR-11 text for one of the four Ollama states. */
export function ollamaStateGuidance(state: OllamaState, modelId = ""): OllamaGuidance {
  const id = modelId === "" ? D2_DEFAULT_MODEL_ID : modelId;
  const pull = pullCommandFor(id);
  switch (state) {
    case OllamaState.NotInstalled:
      return {
        description: `Ollama is not installed. Install it from ${OLLAMA_INSTALL_URL}, then run \`${pull}\` to get the recommended model. ${KEYWORD_SEARCH_STILL_WORKS}`,
        command: "",
      };
    case OllamaState.NotRunning:
      return {
        description: `Ollama is installed but not running. Start it, then run \`${pull}\` if the model isn't pulled yet. ${KEYWORD_SEARCH_STILL_WORKS}`,
        command: "ollama serve",
      };
    case OllamaState.ModelMissing:
      return {
        description: `Ollama is running but ${id} is not pulled yet. Run \`${pull}\` to get it. ${KEYWORD_SEARCH_STILL_WORKS}`,
        command: pull,
      };
    case OllamaState.Ready:
      return {
        description: `Ollama is running with ${id} available. Semantic search is ready.`,
        command: "",
      };
    default:
      throw new Error(`storage: unknown OllamaState ${String(state)}`);
  }
}

function defaultOllamaProvider(): EmbeddingProvider {
  return {
    name: "Ollama Local",
    apiBase: OLLAMA_PROVIDER_API_BASE,
    timeout: 30,
    batchSize: 64,
    retry: { maxRetries: 3, initialDelay: 1000, maxDelay: 30000 },
  };
}

/** SeedDefaults: merge the D2 models and the ollama provider in place, never overwriting. */
export function seedDefaults(settings: EmbeddingSettings | undefined): boolean {
  if (!settings) return false;
  let changed = false;
  settings.providers ??= {};
  settings.models ??= {};
  if (!Object.hasOwn(settings.providers, OLLAMA_PROVIDER_ID)) {
    settings.providers[OLLAMA_PROVIDER_ID] = defaultOllamaProvider();
    changed = true;
  }
  for (const def of D2_MODELS) {
    if (Object.hasOwn(settings.models, def.id)) continue;
    settings.models[def.id] = { ...def.model };
    changed = true;
  }
  return changed;
}

// --- semantic_resolve.go -----------------------------------------------------------------------

const LEGACY_SEMANTIC_PROVIDER = "local";

/**
 * ResolveSemanticSearch: `provider: local` (or omitted) resolves in memory to ollama with the D2
 * default model. The input is never mutated; other providers are returned as a copy.
 */
export function resolveSemanticSearch(
  settings: SemanticSearchSettings | undefined,
): SemanticSearchSettings | undefined {
  if (!settings) return undefined;
  const resolved: SemanticSearchSettings = { ...settings };
  const provider = resolved.provider ?? "";
  if (provider !== LEGACY_SEMANTIC_PROVIDER && provider !== "") return resolved;
  const def = findDefault();
  resolved.provider = OLLAMA_PROVIDER_ID;
  resolved.model = def.id;
  resolved.dimensions = def.model.dimensions;
  resolved.maxTokens = def.model.maxTokens ?? 0;
  delete resolved.huggingFaceId;
  return resolved;
}
