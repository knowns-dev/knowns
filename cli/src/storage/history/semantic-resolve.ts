// Port of internal/storage/semantic_resolve.go (spec ollama-only-embedding D1/FR-3).
import type { SemanticSearchSettings } from "../../models/index.ts";

export const OLLAMA_PROVIDER_ID = "ollama";

/** Pre-Ollama-only default provider; an explicit "local" and an omitted provider mean the same. */
export const LEGACY_SEMANTIC_PROVIDER = "local";

/**
 * D2 default embedding model (qwen3-embedding:0.6b). Mirrors the Default entry of Go's D2Models
 * (internal/storage/embedding_registry_defaults.go), which has no TS port yet.
 */
export const D2_DEFAULT_MODEL = {
  id: "qwen3-embedding:0.6b",
  dimensions: 1024,
  maxTokens: 32768,
} as const;

/**
 * Resolves settings so a project declaring provider "local" (or omitting it) behaves as ollama
 * with the D2 default model. The input is never mutated; undefined in, undefined out. Any other
 * provider is returned as an unchanged copy.
 */
export function resolveSemanticSearch(
  settings: SemanticSearchSettings | undefined | null,
): SemanticSearchSettings | undefined {
  if (!settings) return undefined;
  const resolved: SemanticSearchSettings = { ...settings };
  const provider = resolved.provider ?? "";
  if (provider !== LEGACY_SEMANTIC_PROVIDER && provider !== "") return resolved;

  resolved.provider = OLLAMA_PROVIDER_ID;
  resolved.model = D2_DEFAULT_MODEL.id;
  resolved.dimensions = D2_DEFAULT_MODEL.dimensions;
  resolved.maxTokens = D2_DEFAULT_MODEL.maxTokens;
  // huggingFaceId only meant something for provider "local".
  delete resolved.huggingFaceId;
  return resolved;
}
