// Port of search.InitSemantic (internal/search/init.go): the embedder and the legacy SQLite vector
// store (`<store>/.search/index.db`) that `search --reindex`, the in-process indexer and
// `sync` use. Unlike the runtime session it does not look at the Qdrant backend.
import { join } from "node:path";
import { loadSemanticRuntimeConfig, type SearchEnvironment } from "../../search/config.ts";
import { APIEmbedder } from "../../search/embedder.ts";
import { SemanticNotConfiguredError } from "../../search/errors.ts";
import { MockEmbedder, mockEmbedderEnabled } from "../../search/mock-embedder.ts";
import { SQLiteVectorStore } from "../../search/sqlite-store.ts";
import type { EmbedderProvider } from "../../search/types.ts";
import type { Storage } from "../../storage/adapters.ts";
import { IndexService } from "./index-service.ts";

export interface LegacySemantic {
  embedder: EmbedderProvider;
  store: SQLiteVectorStore;
}

/** Throws SemanticNotConfiguredError when semantic search is off. */
export function initSemanticSqlite(storage: Storage, env: SearchEnvironment): LegacySemantic {
  const searchDir = join(storage.store.root, ".search");
  if (mockEmbedderEnabled(env.env ?? process.env)) {
    const ss = storage.config.load().settings.semanticSearch;
    if (!ss?.enabled || !ss.model) throw new SemanticNotConfiguredError();
    const embedder = new MockEmbedder();
    const store = new SQLiteVectorStore(
      searchDir,
      embedder.modelConfig().name,
      embedder.dimensions(),
    );
    store.load();
    return { embedder, store };
  }
  const cfg = loadSemanticRuntimeConfig(storage, env);
  const embedder = new APIEmbedder(cfg.apiConfig, { fetch: env.fetch, sleep: env.sleep });
  const store = new SQLiteVectorStore(searchDir, cfg.modelId, cfg.dimensions);
  try {
    store.load();
  } catch (err) {
    embedder.close();
    throw new Error(`load vector store: ${(err as Error).message}`);
  }
  return { embedder, store };
}

/** InitSemantic's auto-reindex when the model changed and the old index still has rows. */
export async function autoReindexIfStale(storage: Storage, sem: LegacySemantic): Promise<void> {
  if (sem.store.needsRebuild(sem.store.model()) && sem.store.count() > 0) {
    try {
      await new IndexService(storage, sem.embedder, sem.store).reindex();
    } catch (err) {
      process.stderr.write(`warning: auto-reindex failed: ${(err as Error).message}\n`);
    }
  }
}
