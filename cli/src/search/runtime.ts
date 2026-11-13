// Port of internal/search/runtime_search.go and semantic_runtime.go, local path: a search that
// asks the semantic layer first and degrades to keyword results with a notice when it cannot
// answer. The runtime queue (daemon hand-off, background bootstrap) is out of scope: its seams are
// `SearchEnvironment.queueReindex` and the in-process session below.

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  SEMANTIC_VECTOR_BACKEND_QDRANT,
  SEMANTIC_VECTOR_BACKEND_SQLITE,
} from "../models/config.ts";
import type { RetrievalOptions, RetrievalResponse, SearchResult } from "../models/search.ts";
import type { Storage } from "../storage/adapters.ts";
import {
  assertRuntimeEnabled,
  environmentOf,
  loadSemanticRuntimeConfig,
  resolveEffectiveVectorStore,
  type SearchEnvironment,
  type SemanticRuntimeConfig,
  semanticRuntimeEnabled,
} from "./config.ts";
import { APIEmbedder } from "./embedder.ts";
import {
  Engine,
  effectiveMode,
  type MemorySemanticStore,
  typeFilterFromSources,
} from "./engine.ts";
import {
  errorChainHas,
  errorMessage,
  SemanticNotConfiguredError,
  SemanticRuntimeDisabledError,
} from "./errors.ts";
import { loadQdrantPointer } from "./qdrant/pointer.ts";
import { EmptyVectorStore, QdrantVectorStore } from "./qdrant/store.ts";
import { semanticIndexReadinessQdrant, semanticIndexReadinessSqlite } from "./readiness.ts";
import { shapeRuntime, shapeSearchResult } from "./results.ts";
import { SQLiteVectorStore } from "./sqlite-store.ts";
import { goTrimSpace } from "./text.ts";
import type { ChunkType, EmbedderProvider, SearchOptions, VectorStore } from "./types.ts";

export interface RuntimeMetadata {
  degraded?: boolean;
  warming?: boolean;
  bootstrapQueued?: boolean;
  mode?: string;
  reason?: string;
  message?: string;
}

export interface RuntimeSearchResponse {
  results: SearchResult[];
  runtime?: RuntimeMetadata;
}

/** A semantic session: the embedder and vector store a search runs against. */
export class SemanticSession {
  constructor(
    readonly embedder: EmbedderProvider,
    readonly vecStore: VectorStore,
  ) {}

  engine(
    storage: Storage,
    env: SearchEnvironment,
    extra: Partial<ConstructorParameters<typeof Engine>[0]> = {},
  ): Engine {
    return new Engine({
      storage,
      embedder: this.embedder,
      vecStore: this.vecStore,
      memorySemantic: () => openMemorySemanticStores(storage, env),
      now: env.now,
      ...extra,
    });
  }

  async close(): Promise<void> {
    this.embedder.close();
    await this.vecStore.close();
  }
}

/** OpenSession: embedder from the registry, vector store from the effective backend. */
export function openSemanticSession(storage: Storage, env: SearchEnvironment): SemanticSession {
  assertRuntimeEnabled(environmentOf(env));
  const cfg = loadSemanticRuntimeConfig(storage, env);
  const embedder = new APIEmbedder(cfg.apiConfig, { fetch: env.fetch, sleep: env.sleep });
  let vecStore: VectorStore;
  try {
    vecStore = openRuntimeVectorStore(storage, env, cfg);
  } catch (err) {
    // A first Qdrant generation has no pointer yet. Keep the embedder usable for the generation
    // builder; normal search preflight still degrades until activation creates the pointer.
    if (resolveEffectiveVectorStore(storage, env).backend === SEMANTIC_VECTOR_BACKEND_QDRANT) {
      vecStore = new EmptyVectorStore(cfg.modelId);
    } else {
      throw err;
    }
  }
  return new SemanticSession(embedder, vecStore);
}

/** openRuntimeVectorStore (semantic_runtime.go): Qdrant, or the SQLite index for `sqlite`. */
function openRuntimeVectorStore(
  storage: Storage,
  env: SearchEnvironment,
  cfg: SemanticRuntimeConfig,
): VectorStore {
  const root = storage.store.root;
  const backend = resolveEffectiveVectorStore(storage, env).backend;
  if (backend === SEMANTIC_VECTOR_BACKEND_QDRANT) {
    // A project that has not activated a Qdrant generation yet reads its old SQLite index.
    let pointerMissing = false;
    try {
      pointerMissing = loadQdrantPointer(root) === undefined;
    } catch {
      pointerMissing = false;
    }
    if (pointerMissing && existsSync(join(root, ".search", "index.db"))) {
      const legacy = new SQLiteVectorStore(join(root, ".search"), cfg.modelId, cfg.dimensions);
      try {
        legacy.load();
      } catch (err) {
        throw new Error(`load temporary legacy SQLite fallback: ${(err as Error).message}`);
      }
      return legacy;
    }
    return QdrantVectorStore.open(storage, env, cfg.modelId, cfg.dimensions);
  }
  const store = new SQLiteVectorStore(join(root, ".search"), cfg.modelId, cfg.dimensions);
  try {
    store.load();
  } catch (err) {
    throw new Error(`load vector store: ${(err as Error).message}`);
  }
  return store;
}

/** initMemorySemanticStores: sessions for the project store and, when wired, the global store. */
export async function openMemorySemanticStores(
  projectStorage: Storage,
  env: SearchEnvironment,
): Promise<MemorySemanticStore[]> {
  const stores: MemorySemanticStore[] = [];
  const add = (storage: Storage, memoryLayer: string, storeName: string) => {
    try {
      const session = openSemanticSession(storage, env);
      stores.push({
        engine: new Engine({
          storage,
          embedder: session.embedder,
          vecStore: session.vecStore,
          now: env.now,
        }),
        memoryLayer,
        storeName,
        close: () => session.close(),
      });
    } catch {
      // a store without a usable session simply contributes nothing
    }
  };
  add(projectStorage, "project", "project-store");
  const global = env.globalStorage?.();
  if (global) add(global, "global", "global-store");
  return stores;
}

// --- preflight ----------------------------------------------------------------------------------------

function chunkTypesForRuntimePreflight(searchType: string | undefined): ChunkType[] {
  switch (searchType) {
    case "doc":
    case "task":
    case "decision":
    case "code":
      return [searchType];
    default:
      return [];
  }
}

function semanticIndexAvailableForType(
  storage: Storage,
  env: SearchEnvironment,
  cfg: SemanticRuntimeConfig,
  chunkTypes: ChunkType[],
): boolean {
  const expectation = { model: cfg.modelId, dimensions: cfg.dimensions };
  switch (resolveEffectiveVectorStore(storage, env).backend) {
    case SEMANTIC_VECTOR_BACKEND_QDRANT:
      return semanticIndexReadinessQdrant(storage, expectation, chunkTypes).ready;
    case SEMANTIC_VECTOR_BACKEND_SQLITE:
      return semanticIndexReadinessSqlite(storage, expectation, chunkTypes).ready;
    default:
      return false;
  }
}

function memorySemanticIndexAvailable(
  storage: Storage | undefined,
  env: SearchEnvironment,
): boolean {
  if (!storage) return false;
  try {
    const cfg = loadSemanticRuntimeConfig(storage, env);
    return semanticIndexAvailableForType(storage, env, cfg, ["memory"]);
  } catch {
    return false;
  }
}

/** Throws SemanticNotConfiguredError when semantic search is opted out. */
export function semanticIndexAvailableForRuntime(
  storage: Storage,
  env: SearchEnvironment,
  searchType: string | undefined,
): boolean {
  const cfg = loadSemanticRuntimeConfig(storage, env);
  if (resolveEffectiveVectorStore(storage, env).optedOut) {
    // Explicit opt-out is keyword-only behaviour, reported as not configured rather than failed.
    throw new SemanticNotConfiguredError();
  }
  if (searchType !== "memory") {
    if (
      semanticIndexAvailableForType(storage, env, cfg, chunkTypesForRuntimePreflight(searchType))
    ) {
      return true;
    }
  }
  if (searchType === "memory" || !searchType || searchType === "all") {
    if (memorySemanticIndexAvailable(storage, env)) return true;
    if (memorySemanticIndexAvailable(env.globalStorage?.(), env)) return true;
  }
  return false;
}

// --- degraded metadata ----------------------------------------------------------------------------------

function runtimeReason(err: unknown): string {
  if (errorChainHas(err, SemanticRuntimeDisabledError)) return "disabled";
  if (errorChainHas(err, SemanticNotConfiguredError)) return "not_configured";
  return "unavailable";
}

export function degradedRuntimeMetadata(mode: string, err: unknown): RuntimeMetadata {
  let message = "semantic runtime unavailable; returned keyword results only";
  if (err !== undefined) message += `: ${errorMessage(err)}`;
  return { degraded: true, mode, reason: runtimeReason(err), message };
}

interface BootstrapRequest {
  eligible: boolean;
  queued: boolean;
  reason: string;
}

function bootstrapEligibility(
  storage: Storage,
  env: SearchEnvironment,
  cause: unknown,
): BootstrapRequest {
  if (
    errorChainHas(cause, SemanticRuntimeDisabledError) ||
    errorChainHas(cause, SemanticNotConfiguredError)
  ) {
    return {
      eligible: false,
      queued: false,
      reason: "semantic runtime disabled or not configured",
    };
  }
  const res = resolveEffectiveVectorStore(storage, env);
  if (!res.enabled || res.optedOut || res.backend === "none") {
    return { eligible: false, queued: false, reason: "semantic vector search disabled" };
  }
  if (res.backend !== SEMANTIC_VECTOR_BACKEND_QDRANT) {
    return { eligible: false, queued: false, reason: "semantic backend is not qdrant" };
  }
  if (goTrimSpace(storage.store.root) === "") {
    return { eligible: false, queued: false, reason: "store root is empty" };
  }
  return { eligible: true, queued: false, reason: "qdrant bootstrap/reindex queued" };
}

/** Queues the background reindex when a queue is wired; the search never waits for it. */
function queueBootstrap(
  storage: Storage,
  env: SearchEnvironment,
  cause: unknown,
): BootstrapRequest {
  const request = bootstrapEligibility(storage, env, cause);
  if (!request.eligible || !env.queueReindex) return request;
  request.queued = true;
  const root = storage.store.root;
  const queue = env.queueReindex;
  void Promise.resolve()
    .then(() => queue(root))
    .catch(() => {
      // surfaced through status/doctor, never to a caller that already has fallback results
    });
  return request;
}

function applyBootstrapMetadata(meta: RuntimeMetadata, bootstrap: BootstrapRequest): void {
  if (!bootstrap.queued) return;
  meta.warming = true;
  meta.bootstrapQueued = true;
  if (bootstrap.reason !== "") {
    if (!meta.message) meta.message = bootstrap.reason;
    else if (!meta.message.includes("qdrant bootstrap")) meta.message += `; ${bootstrap.reason}`;
  }
}

function attachRuntimeWarning(results: SearchResult[], meta: RuntimeMetadata): SearchResult[] {
  return results.map((r) => shapeSearchResult({ ...r, _runtime: shapeRuntime({ ...meta }) }));
}

// --- search ---------------------------------------------------------------------------------------------

async function keywordFallback(
  storage: Storage,
  env: SearchEnvironment,
  opts: SearchOptions,
): Promise<SearchResult[]> {
  return new Engine({ storage, now: env.now }).search({ ...opts, mode: "keyword" });
}

async function semanticUnavailableResponse(
  storage: Storage,
  env: SearchEnvironment,
  opts: SearchOptions,
  mode: string,
  err: unknown,
): Promise<RuntimeSearchResponse> {
  const bootstrap = queueBootstrap(storage, env, err);
  if (mode === "semantic") {
    const base = `semantic runtime unavailable: ${errorMessage(err)}`;
    throw new Error(
      bootstrap.queued
        ? `semantic runtime unavailable; qdrant bootstrap/reindex queued: ${errorMessage(err)}`
        : base,
      { cause: err },
    );
  }
  const results = await keywordFallback(storage, env, opts);
  const meta = degradedRuntimeMetadata(mode, err);
  applyBootstrapMetadata(meta, bootstrap);
  return { results: attachRuntimeWarning(results, meta), runtime: shapeRuntime(meta) };
}

/**
 * SearchWithRuntime (local path). A keyword search never touches the semantic layer; any other
 * mode checks readiness, opens a session, and falls back to keyword results with a notice when
 * the semantic leg cannot answer.
 */
export async function searchWithRuntime(
  storage: Storage,
  env: SearchEnvironment,
  input: SearchOptions,
): Promise<RuntimeSearchResponse> {
  const opts: SearchOptions = { ...input };
  let mode = opts.mode ?? "";
  if (mode === "") {
    mode = "hybrid";
    opts.mode = mode;
  }
  if (mode === "keyword") {
    return { results: await new Engine({ storage, now: env.now }).search(opts) };
  }
  if (semanticRuntimeEnabled(environmentOf(env))) {
    let available: boolean;
    try {
      available = semanticIndexAvailableForRuntime(storage, env, opts.type);
    } catch (err) {
      return semanticUnavailableResponse(storage, env, opts, mode, err);
    }
    if (!available) {
      return semanticUnavailableResponse(
        storage,
        env,
        opts,
        mode,
        new Error("semantic index is empty or unavailable"),
      );
    }
  }

  let session: SemanticSession;
  try {
    session = openSemanticSession(storage, env);
  } catch (err) {
    return semanticUnavailableResponse(storage, env, opts, mode, err);
  }
  try {
    const engine = session.engine(storage, env);
    const available = await engine.semanticAvailableFor(opts.type ?? "all");
    if (mode === "semantic" && !available) {
      throw new Error("semantic runtime unavailable: semantic index is empty or unavailable");
    }
    if (mode === "hybrid" && !available) {
      const results = await keywordFallback(storage, env, opts);
      const meta = degradedRuntimeMetadata(
        mode,
        new Error("semantic index is empty or unavailable"),
      );
      return { results: attachRuntimeWarning(results, meta), runtime: shapeRuntime(meta) };
    }
    let outcome: Awaited<ReturnType<Engine["searchWithDegradation"]>>;
    try {
      outcome = await engine.searchWithDegradation(opts);
    } catch (err) {
      return semanticUnavailableResponse(storage, env, opts, mode, err);
    }
    if (outcome.degraded) {
      // The engine already ran the keyword leg; the bootstrap still has to be queued because a
      // degraded search is exactly the signal that the semantic index needs repair.
      const bootstrap = queueBootstrap(storage, env, outcome.degraded.err);
      const meta = degradedRuntimeMetadata(mode, outcome.degraded.err);
      applyBootstrapMetadata(meta, bootstrap);
      return { results: attachRuntimeWarning(outcome.results, meta), runtime: shapeRuntime(meta) };
    }
    return { results: outcome.results };
  } finally {
    await session.close();
  }
}

/** RetrieveWithRuntime: runtime-backed search, then candidates and the context pack. */
export async function retrieveWithRuntime(
  storage: Storage,
  env: SearchEnvironment,
  opts: RetrievalOptions,
): Promise<{ response: RetrievalResponse; runtime: RuntimeMetadata | undefined }> {
  const engine = new Engine({ storage, references: env.references, now: env.now });
  let searchOpts = engine.resolveTaskVisibility({
    query: opts.query,
    type: typeFilterFromSources(opts.sourceTypes),
    mode: opts.mode,
    status: opts.status,
    priority: opts.priority,
    assignee: opts.assignee,
    label: opts.label,
    tag: opts.tag,
    limit: opts.limit,
    includeHistorical: opts.includeHistorical,
    purpose: "ai-retrieval",
  });
  searchOpts = await engine.withTaskSnapshot(searchOpts);
  const searchResp = await searchWithRuntime(storage, env, searchOpts);
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 20;
  const { candidates, items } = engine.assembleRetrieval(
    searchResp.results,
    opts,
    searchOpts,
    limit,
  );
  const degraded = searchResp.runtime?.degraded === true;
  return {
    response: {
      query: opts.query,
      mode: effectiveMode(opts.mode ?? "", !degraded),
      candidates,
      contextPack: { items, mode: "docs-first" },
    },
    runtime: searchResp.runtime,
  };
}
