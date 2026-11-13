// Port of internal/search/qdrant_vecstore.go: the production read path. Every query is validated
// against the pointer and the canonical sources before result assembly sees it. Writes belong to
// the generation builder, so this store has none.
import { SEMANTIC_VECTOR_STORE_MODE_MANAGED } from "../../models/config.ts";
import type { Storage } from "../../storage/adapters.ts";
import { environmentOf, resolveEffectiveVectorStore, type SearchEnvironment } from "../config.ts";
import {
  CHUNK_VERSION,
  type ScoredChunk,
  type VectorSearchOpts,
  type VectorStore,
} from "../types.ts";
import { type QdrantClient, QdrantHttpClient } from "./client.ts";
import { loadQdrantPointer, type QdrantPointer } from "./pointer.ts";
import type { QdrantHitValidationSummary } from "./validation.ts";

export const ENV_QDRANT_API_KEY = "KNOWNS_QDRANT_API_KEY";
/** The managed runtime listens here; the endpoint is not read from anywhere else. */
export const MANAGED_QDRANT_URL = "http://127.0.0.1:6333";

/** The Qdrant client for the store's managed or external endpoint, never exposing the API key. */
export function qdrantClientForStore(storage: Storage, env: SearchEnvironment): QdrantClient {
  const res = resolveEffectiveVectorStore(storage, env);
  let endpoint = res.externalURL.trim();
  if (res.mode === SEMANTIC_VECTOR_STORE_MODE_MANAGED) endpoint = MANAGED_QDRANT_URL;
  return new QdrantHttpClient({
    url: endpoint,
    apiKey: environmentOf(env)[ENV_QDRANT_API_KEY] ?? "",
    fetch: env.fetch,
  });
}

export class QdrantVectorStore implements VectorStore {
  private lastValidation: QdrantHitValidationSummary = {
    checked: 0,
    dropped: 0,
    reindexRecommended: false,
    reasons: [],
  };
  private lastSearchErr: Error | undefined;

  constructor(
    private readonly storage: Storage,
    private readonly client: QdrantClient,
    private readonly pointer: QdrantPointer,
    private readonly modelId: string,
    private readonly dims: number,
  ) {}

  /** OpenQdrantVectorStore: needs an active pointer; there is none before the first index. */
  static open(
    storage: Storage,
    env: SearchEnvironment,
    model: string,
    dims: number,
  ): QdrantVectorStore {
    const pointer = loadQdrantPointer(storage.store.root);
    if (!pointer) throw new Error("qdrant pointer missing; run: knowns search index --wait");
    return new QdrantVectorStore(storage, qdrantClientForStore(storage, env), pointer, model, dims);
  }

  async search(queryVec: Float32Array, opts: VectorSearchOpts): Promise<ScoredChunk[]> {
    try {
      const { chunks, summary } = await this.client.queryValidated(
        this.pointer.collectionName,
        queryVec,
        { topK: opts.topK, threshold: opts.threshold, chunkType: opts.chunkType },
        {
          storage: this.storage,
          pointer: this.pointer,
          expectedModel: this.modelId,
          expectedDimensions: this.dims,
        },
      );
      this.lastValidation = summary;
      this.lastSearchErr = undefined;
      return chunks;
    } catch (err) {
      this.lastSearchErr = err as Error;
      return [];
    }
  }

  count(): number {
    return this.pointer.chunkCount;
  }

  needsRebuild(model: string): boolean {
    return (
      this.pointer.embedding.model !== model ||
      this.pointer.embedding.dimensions !== this.dims ||
      this.pointer.chunkVersion !== CHUNK_VERSION
    );
  }

  stats(): { chunkCount: number; model: string; indexedAt: string | undefined } {
    return {
      chunkCount: this.pointer.chunkCount,
      model: this.pointer.embedding.model,
      indexedAt: this.pointer.lastIndexedAt ?? undefined,
    };
  }

  model(): string {
    return this.modelId;
  }

  close(): void {}

  validation(): QdrantHitValidationSummary {
    return this.lastValidation;
  }

  lastSearchError(): Error | undefined {
    return this.lastSearchErr;
  }
}

/**
 * newQdrantStageStore: a first Qdrant generation has no pointer yet, so a session still needs a
 * vector store that reports itself empty (and therefore unavailable) rather than failing to open.
 */
export class EmptyVectorStore implements VectorStore {
  constructor(private readonly modelId: string) {}
  async search(): Promise<ScoredChunk[]> {
    return [];
  }
  count(): number {
    return 0;
  }
  needsRebuild(): boolean {
    return false;
  }
  stats(): { chunkCount: number; model: string; indexedAt: string | undefined } {
    return { chunkCount: 0, model: this.modelId, indexedAt: undefined };
  }
  model(): string {
    return this.modelId;
  }
  close(): void {}
}
