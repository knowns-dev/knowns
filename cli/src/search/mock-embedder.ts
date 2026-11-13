// Port of internal/search/mock_embedder.go: a deterministic in-process embedder (KNOWNS_EMBED_MOCK)
// so CI can exercise the semantic paths without Ollama. The vector is derived from a chained
// SHA-256 of the text, exactly like Go, so both builds produce identical vectors.
import { createHash } from "node:crypto";
import type { EmbedderProvider, EmbeddingModelConfig, Tokenizer } from "./types.ts";

export const ENV_MOCK_EMBEDDER = "KNOWNS_EMBED_MOCK";
const DIMENSIONS = 32;

export function mockEmbedderEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return ["1", "true", "yes", "on"].includes((env[ENV_MOCK_EMBEDDER] ?? "").trim().toLowerCase());
}

function vector(text: string): Float32Array {
  const vec = new Float32Array(DIMENSIONS);
  let sum = createHash("sha256").update(text, "utf8").digest();
  let norm = 0;
  const raw: number[] = [];
  for (let i = 0; i < DIMENSIONS; i++) {
    if (i > 0 && i % 8 === 0) sum = createHash("sha256").update(sum).digest();
    const bits = sum.readUInt32BE((i % 8) * 4);
    const v = (bits / 0xffffffff) * 2 - 1;
    raw.push(v);
    norm += v * v;
  }
  if (norm === 0) {
    vec[0] = 1;
    return vec;
  }
  const inv = Math.fround(1 / Math.sqrt(norm));
  for (let i = 0; i < DIMENSIONS; i++) vec[i] = Math.fround(Math.fround(raw[i] as number) * inv);
  return vec;
}

export class MockEmbedder implements EmbedderProvider {
  async embed(text: string): Promise<Float32Array> {
    return vector(text);
  }
  embedDocument = this.embed;
  embedQuery = this.embed;
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map(vector);
  }
  embedDocumentBatch = this.embedBatch;
  embedQueryBatch = this.embedBatch;
  dimensions(): number {
    return DIMENSIONS;
  }
  modelConfig(): EmbeddingModelConfig {
    return { name: "mock-deterministic", dimensions: DIMENSIONS, maxTokens: 8192 };
  }
  getTokenizer(): Tokenizer | undefined {
    return undefined;
  }
  close(): void {}
}
