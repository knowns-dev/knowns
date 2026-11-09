// Semantic runtime configuration (semantic_runtime.go loadSemanticRuntimeConfig and
// semantic_readiness.go resolveEffectiveVectorStore): which embedder, model and vector store a
// project resolves to. The machine-level embedding registry is injected because it is not part of
// the per-project storage factory.
import { type SemanticSearchSettings, semanticSearchSettingsSchema } from "../models/config.ts";
import { type ResolvedVectorStore, resolveVectorStoreForEnv } from "../runtime/qdrant-endpoint.ts";
import type { Storage } from "../storage/adapters.ts";
import type { APIEmbedderConfig } from "./embedder.ts";
import type { ReferenceExtractor } from "./engine.ts";
import { SemanticNotConfiguredError, SemanticRuntimeDisabledError } from "./errors.ts";
import { goTrimSpace } from "./text.ts";

/** The slice of the machine-level embedding registry (~/.knowns/settings.json) search needs. */
export interface EmbeddingRegistry {
  providers: Record<
    string,
    {
      name?: string;
      apiBase: string;
      apiKey?: string;
      timeout?: number;
      batchSize?: number;
      retry?: { maxRetries: number; initialDelay: number; maxDelay: number };
    }
  >;
  models: Record<
    string,
    {
      provider: string;
      model: string;
      dimensions: number;
      maxTokens?: number;
      queryPrefix?: string;
      docPrefix?: string;
    }
  >;
  projectDefaults?: { settings: Record<string, unknown> };
}

/** Everything the semantic layer needs from outside the project storage. */
export interface SearchEnvironment {
  /** Loads the machine-level registry (EmbeddingSettingsStore.load in the storage layer). */
  embeddingRegistry(): EmbeddingRegistry;
  /** The machine-level store whose memories are searched as the "global" layer, when wired. */
  globalStorage?: () => Storage | undefined;
  /** internal/references.Extract, needed by reference expansion (not ported yet). */
  references?: ReferenceExtractor;
  /** Process environment; defaults to process.env. */
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /**
   * Queues a background Qdrant bootstrap/reindex (the runtime queue). When absent a degraded
   * search still reports its reason but cannot claim a bootstrap was queued.
   */
  queueReindex?: (storeRoot: string) => void | Promise<void>;
}

export function environmentOf(env: SearchEnvironment): Record<string, string | undefined> {
  return env.env ?? process.env;
}

export interface SemanticRuntimeConfig {
  provider: string;
  providerIdentity: string;
  /** The model id as written in project settings (registry key). */
  modelId: string;
  /** The model name the provider receives. */
  modelName: string;
  dimensions: number;
  apiConfig: APIEmbedderConfig;
}

const LEGACY_SEMANTIC_PROVIDER = "local";
const D2_DEFAULT = { id: "qwen3-embedding:0.6b", dimensions: 1024, maxTokens: 32768 } as const;

/** ResolveSemanticSearch: `provider: local` (or omitted) resolves in memory to the D2 default. */
export function resolveSemanticSearchSettings(
  settings: SemanticSearchSettings | undefined,
): SemanticSearchSettings | undefined {
  if (!settings) return undefined;
  const resolved: SemanticSearchSettings = { ...settings };
  const provider = resolved.provider ?? "";
  if (provider !== LEGACY_SEMANTIC_PROVIDER && provider !== "") return resolved;
  resolved.provider = "ollama";
  resolved.model = D2_DEFAULT.id;
  resolved.dimensions = D2_DEFAULT.dimensions;
  resolved.maxTokens = D2_DEFAULT.maxTokens;
  delete resolved.huggingFaceId;
  return resolved;
}

/** KNOWNS_SEMANTIC_RUNTIME_DISABLED / KNOWNS_SEMANTIC_RUNTIME switch the whole layer off. */
export function semanticRuntimeDisabledReason(env: Record<string, string | undefined>): {
  disabled: boolean;
  reason: string;
} {
  const v = goTrimSpace(env.KNOWNS_SEMANTIC_RUNTIME_DISABLED ?? "");
  if (v !== "" && ["1", "true", "yes", "on", "enabled"].includes(v.toLowerCase())) {
    return { disabled: true, reason: "KNOWNS_SEMANTIC_RUNTIME_DISABLED" };
  }
  const r = goTrimSpace(env.KNOWNS_SEMANTIC_RUNTIME ?? "");
  if (r !== "" && ["0", "false", "off", "disabled", "disable"].includes(r.toLowerCase())) {
    return { disabled: true, reason: "KNOWNS_SEMANTIC_RUNTIME" };
  }
  return { disabled: false, reason: "" };
}

export function semanticRuntimeEnabled(env: Record<string, string | undefined>): boolean {
  return !semanticRuntimeDisabledReason(env).disabled;
}

export function assertRuntimeEnabled(env: Record<string, string | undefined>): void {
  const { disabled, reason } = semanticRuntimeDisabledReason(env);
  if (disabled) throw new SemanticRuntimeDisabledError(reason);
}

/** EmbeddingProvider.WithDefaults. */
function providerWithDefaults(p: EmbeddingRegistry["providers"][string]) {
  const retry = { ...(p.retry ?? { maxRetries: 0, initialDelay: 0, maxDelay: 0 }) };
  if (retry.maxRetries <= 0) retry.maxRetries = 3;
  if (retry.initialDelay <= 0) retry.initialDelay = 1000;
  if (retry.maxDelay <= 0) retry.maxDelay = 30000;
  return {
    apiBase: p.apiBase,
    apiKey: p.apiKey ?? "",
    timeout: p.timeout && p.timeout > 0 ? p.timeout : 30,
    batchSize: p.batchSize && p.batchSize > 0 ? p.batchSize : 64,
    retry,
  };
}

/** loadSemanticRuntimeConfig. Throws SemanticNotConfiguredError when semantic search is off. */
export function loadSemanticRuntimeConfig(
  storage: Storage,
  env: SearchEnvironment,
): SemanticRuntimeConfig {
  let settings: SemanticSearchSettings | undefined;
  try {
    settings = storage.config.load().settings.semanticSearch;
  } catch (err) {
    throw new Error(`load config: ${(err as Error).message}`, { cause: err });
  }
  if (!settings?.enabled || !settings.model) throw new SemanticNotConfiguredError();
  const ss = resolveSemanticSearchSettings(settings) as SemanticSearchSettings;
  const providerType = ss.provider || "ollama";

  let registry: EmbeddingRegistry;
  try {
    registry = env.embeddingRegistry();
  } catch (err) {
    throw new Error(`load embedding settings: ${(err as Error).message}`, { cause: err });
  }
  const model = registry.models[ss.model];
  if (!model) throw new Error(`resolve embedding model: embedding model "${ss.model}" not found`);
  const rawProvider = registry.providers[model.provider];
  if (!rawProvider) {
    throw new Error(`resolve embedding provider: embedding provider "${model.provider}" not found`);
  }
  const provider = providerWithDefaults(rawProvider);
  // Project settings win over the machine-wide registry so one project can chunk differently.
  const maxTokens = ss.maxTokens && ss.maxTokens > 0 ? ss.maxTokens : (model.maxTokens ?? 0);
  return {
    provider: providerType,
    providerIdentity: `${model.provider}@${provider.apiBase}`,
    modelId: ss.model,
    modelName: model.model,
    dimensions: model.dimensions,
    apiConfig: {
      apiBase: provider.apiBase,
      apiKey: provider.apiKey,
      model: model.model,
      dimensions: model.dimensions,
      maxTokens,
      timeout: provider.timeout,
      batchSize: provider.batchSize,
      retry: provider.retry,
      queryPrefix: model.queryPrefix ?? "",
      docPrefix: model.docPrefix ?? "",
    },
  };
}

/** env override > machine endpoint file (D14) > project config > global settings > defaults. */
export function resolveEffectiveVectorStore(
  storage: Storage | undefined,
  env: SearchEnvironment,
): ResolvedVectorStore {
  if (!storage) return resolveVectorStoreForEnv(undefined, undefined, environmentOf(env));
  let project: SemanticSearchSettings | undefined;
  try {
    project = storage.config.load().settings.semanticSearch;
  } catch {
    project = undefined;
  }
  let global: SemanticSearchSettings | undefined;
  try {
    const raw = env.embeddingRegistry().projectDefaults?.settings.semanticSearch;
    const parsed = semanticSearchSettingsSchema.safeParse(raw);
    if (parsed.success) global = parsed.data;
  } catch {
    global = undefined;
  }
  return resolveVectorStoreForEnv(project, global, environmentOf(env));
}
