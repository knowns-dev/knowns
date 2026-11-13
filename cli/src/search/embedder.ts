// Port of internal/search/embedding_api.go: an OpenAI-compatible /v1/embeddings client (Ollama
// serves one at /v1). Requests, retry policy and error texts follow Go; a transport failure is
// retryable, a 4xx other than 429 is not.
import { z } from "zod";
import { goTransportError } from "../platform/goerror.ts";
import { goJson } from "./json.ts";
import { byteSlicePrefix } from "./text.ts";
import type { EmbedderProvider, EmbeddingModelConfig, Tokenizer } from "./types.ts";

/** The context limit assumed when neither project settings nor the registry declare one. */
export const DEFAULT_API_MAX_TOKENS = 512;

export interface RetryConfig {
  maxRetries: number;
  /** milliseconds */
  initialDelay: number;
  /** milliseconds */
  maxDelay: number;
}

export interface APIEmbedderConfig {
  /** e.g. "http://localhost:11434/v1" */
  apiBase: string;
  apiKey?: string;
  model: string;
  dimensions: number;
  /** 0 falls back to DEFAULT_API_MAX_TOKENS. */
  maxTokens?: number;
  /** seconds per request (default 30) */
  timeout?: number;
  /** max texts per API call (default 64) */
  batchSize?: number;
  retry?: RetryConfig;
  /** Prepended before embedding; asymmetric models take distinct query and passage markers. */
  queryPrefix?: string;
  docPrefix?: string;
}

export interface EmbedderHooks {
  fetch?: typeof fetch;
  /** Backoff sleep; tests inject a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

const embeddingResponseSchema = z.object({
  data: z
    .array(z.object({ index: z.number().default(0), embedding: z.array(z.number()).default([]) }))
    .default([]),
});

function truncate(s: string, maxLen: number): string {
  const bytes = new TextEncoder().encode(s).length;
  return bytes <= maxLen ? s : `${byteSlicePrefix(s, maxLen)}...`;
}

class RetryableError extends Error {}

export class APIEmbedder implements EmbedderProvider {
  private readonly config: Required<
    Omit<APIEmbedderConfig, "apiKey" | "queryPrefix" | "docPrefix">
  > &
    Pick<APIEmbedderConfig, "apiKey" | "queryPrefix" | "docPrefix">;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(cfg: APIEmbedderConfig, hooks: EmbedderHooks = {}) {
    if (cfg.apiBase === "") throw new Error("apiBase is required");
    if (cfg.model === "") throw new Error("model is required");
    if (cfg.dimensions <= 0) throw new Error("dimensions must be positive");
    const retry = { ...(cfg.retry ?? { maxRetries: 0, initialDelay: 0, maxDelay: 0 }) };
    if (retry.maxRetries <= 0) retry.maxRetries = 3;
    if (retry.initialDelay <= 0) retry.initialDelay = 1000;
    if (retry.maxDelay <= 0) retry.maxDelay = 30000;
    this.config = {
      apiBase: cfg.apiBase,
      apiKey: cfg.apiKey,
      model: cfg.model,
      dimensions: cfg.dimensions,
      maxTokens: cfg.maxTokens ?? 0,
      timeout: cfg.timeout && cfg.timeout > 0 ? cfg.timeout : 30,
      batchSize: cfg.batchSize && cfg.batchSize > 0 ? cfg.batchSize : 64,
      retry,
      queryPrefix: cfg.queryPrefix,
      docPrefix: cfg.docPrefix,
    };
    this.fetchImpl = hooks.fetch ?? fetch;
    this.sleep = hooks.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  embed(text: string): Promise<Float32Array> {
    return this.embedDocument(text);
  }

  async embedDocument(text: string): Promise<Float32Array> {
    return this.first(await this.embedBatchRaw([(this.config.docPrefix ?? "") + text]));
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return this.first(await this.embedBatchRaw([(this.config.queryPrefix ?? "") + text]));
  }

  embedBatch(texts: string[]): Promise<Float32Array[]> {
    return this.embedDocumentBatch(texts);
  }

  embedDocumentBatch(texts: string[]): Promise<Float32Array[]> {
    return this.embedSorted(texts.map((t) => (this.config.docPrefix ?? "") + t));
  }

  embedQueryBatch(texts: string[]): Promise<Float32Array[]> {
    return this.embedSorted(texts.map((t) => (this.config.queryPrefix ?? "") + t));
  }

  dimensions(): number {
    return this.config.dimensions;
  }

  modelConfig(): EmbeddingModelConfig {
    return {
      name: this.config.model,
      dimensions: this.config.dimensions,
      maxTokens: this.config.maxTokens > 0 ? this.config.maxTokens : DEFAULT_API_MAX_TOKENS,
      queryPrefix: this.config.queryPrefix,
      docPrefix: this.config.docPrefix,
    };
  }

  getTokenizer(): Tokenizer | undefined {
    return undefined;
  }

  close(): void {}

  async isReachable(): Promise<boolean> {
    try {
      await this.embedBatchRaw(["test"]);
      return true;
    } catch {
      return false;
    }
  }

  private first(vecs: Float32Array[]): Float32Array {
    const v = vecs[0];
    if (!v) throw new Error("embedding API returned no vectors");
    return v;
  }

  /** Sorts by length (less padding), batches, embeds, and restores the original order. */
  private async embedSorted(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const items = texts.map((text, idx) => ({ idx, text }));
    const lengths = new Map(items.map((i) => [i, new TextEncoder().encode(i.text).length]));
    items.sort((a, b) => (lengths.get(a) as number) - (lengths.get(b) as number));
    const results: Float32Array[] = new Array(texts.length);
    const { batchSize } = this.config;
    for (let start = 0; start < items.length; start += batchSize) {
      const end = Math.min(start + batchSize, items.length);
      const batch = items.slice(start, end);
      let vecs: Float32Array[];
      try {
        vecs = await this.embedBatchRaw(batch.map((i) => i.text));
      } catch (err) {
        throw new Error(`embed batch [${start}:${end}]: ${(err as Error).message}`, { cause: err });
      }
      vecs.forEach((vec, i) => {
        results[(batch[i] as { idx: number }).idx] = vec;
      });
    }
    return results;
  }

  private async embedBatchRaw(texts: string[]): Promise<Float32Array[]> {
    const body = goJson({ model: this.config.model, input: texts });
    const { maxRetries } = this.config.retry;
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(this.backoffDelay(attempt));
      try {
        return await this.doRequest(body);
      } catch (err) {
        lastErr = err as Error;
        if (!(err instanceof RetryableError)) throw err;
      }
    }
    throw new Error(`embedding API failed after ${maxRetries} retries: ${lastErr?.message}`, {
      cause: lastErr,
    });
  }

  private async doRequest(body: string): Promise<Float32Array[]> {
    let url = this.config.apiBase.replace(/\/+$/, "");
    if (!url.endsWith("/embeddings")) url += "/embeddings";
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;

    let resp: Response;
    let text: string;
    try {
      resp = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(this.config.timeout * 1000),
      });
      text = await resp.text();
    } catch (err) {
      throw new RetryableError(`http request: ${goTransportError("POST", url, err)}`, {
        cause: err,
      });
    }
    if (resp.status === 429) throw new RetryableError("rate limited (HTTP 429)");
    if (resp.status >= 500) {
      throw new RetryableError(`server error (HTTP ${resp.status}): ${truncate(text, 200)}`);
    }
    if (resp.status !== 200) {
      throw new Error(`API error (HTTP ${resp.status}): ${truncate(text, 200)}`);
    }
    let parsed: z.infer<typeof embeddingResponseSchema>;
    try {
      parsed = embeddingResponseSchema.parse(JSON.parse(text));
    } catch (err) {
      throw new Error(`parse response: ${(err as Error).message}`);
    }
    return [...parsed.data]
      .sort((a, b) => a.index - b.index)
      .map((d) => Float32Array.from(d.embedding));
  }

  private backoffDelay(attempt: number): number {
    const { initialDelay, maxDelay } = this.config.retry;
    const delay = initialDelay * 2 ** (attempt - 1);
    return Math.trunc(Math.min(delay, maxDelay));
  }
}
