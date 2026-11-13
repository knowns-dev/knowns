// Port of internal/search/qdrant_generation.go and the Reindex half of index.go for the Qdrant
// backend: a full rebuild of the next collection generation from canonical sources, validation, an
// atomic pointer swap, watermark stamping and retention cleanup. The rebuild stages every chunk in
// memory (Go's qdrantStageStore) and only then touches Qdrant.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DEFAULT_SEMANTIC_VECTOR_RETENTION_GENERATIONS,
  type SemanticVectorStoreResolution,
} from "../../models/config.ts";
import { decisionCurrentForDefaultRetrieval } from "../../models/decision.ts";
import { memoryCurrentForDefaultRetrieval } from "../../models/memory.ts";
import type { Task } from "../../models/task.ts";
import { chunkDecision, chunkDocument, chunkMemory, chunkTask } from "../../search/chunker.ts";
import { loadSemanticRuntimeConfig, type SearchEnvironment } from "../../search/config.ts";
import { contentHash, decisionContentForHash, taskContentForHash } from "../../search/hash.ts";
import {
  QDRANT_REST_DISTANCE_COSINE,
  type QdrantClient,
  type QdrantPoint,
  qdrantPointFromChunk,
} from "../../search/qdrant/client.ts";
import {
  PAYLOAD_CHUNK_ID,
  PAYLOAD_CHUNK_VERSION,
  PAYLOAD_CONTENT_HASH,
  PAYLOAD_SOURCE_ID,
  payloadInt,
  payloadString,
  sourceIdForChunk,
} from "../../search/qdrant/payload.ts";
import {
  loadQdrantGenerations,
  loadQdrantPointer,
  newQdrantPointer,
  QDRANT_DEFAULT_DISTANCE,
  QDRANT_GENERATION_STATUS_ACTIVE,
  QDRANT_GENERATION_STATUS_DELETED,
  QDRANT_GENERATION_STATUS_INACTIVE,
  type QdrantEmbeddingPointer,
  type QdrantGenerationRecord,
  type QdrantPointer,
  saveQdrantGenerations,
  saveQdrantPointer,
  storeRootFingerprint,
} from "../../search/qdrant/pointer.ts";
import type { WritableVectorStore } from "../../search/sqlite-store.ts";
import { CHUNK_VERSION, type Chunk, type EmbedderProvider } from "../../search/types.ts";
import type { Storage } from "../../storage/adapters.ts";
import { globalSemanticStoreRoot } from "../../storage/core/store.ts";
import { withTaskLifecycleTransaction } from "../../storage/history/lifecycle-tx.ts";
import { goLogf, isProcessAlive, parseGoDurationMs, sleep } from "../queue.ts";
import { IndexService, type ReindexProgress } from "./index-service.ts";
import { stampWatermarksFromGeneration } from "./qdrant-intent.ts";

export const DEFAULT_QDRANT_GENERATION_TTL_MS = 72 * 3_600_000;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_STALE_AFTER_MS = 30 * 60_000;

// --- the stage store ---------------------------------------------------------------------------

/** qdrantStageStore: chunks and source hashes held in memory until the collection is built. */
class StageStore implements WritableVectorStore {
  chunks: Chunk[] = [];
  hashes = new Map<string, string>();
  constructor(private readonly modelName: string) {}
  model(): string {
    return this.modelName;
  }
  clear(): void {
    this.chunks = [];
    this.hashes = new Map();
  }
  addChunks(chunks: Chunk[]): void {
    this.chunks.push(...chunks.filter((c) => c.embedding !== undefined));
  }
  removeByPrefix(prefix: string): void {
    this.chunks = this.chunks.filter((c) => !c.id.startsWith(prefix));
  }
  save(): void {}
  count(): number {
    return this.chunks.length;
  }
  needsRebuild(): boolean {
    return false;
  }
  getContentHash(id: string): string {
    return this.hashes.get(id) ?? "";
  }
  setContentHash(id: string, hash: string): void {
    this.hashes.set(id, hash);
  }
  deleteContentHash(id: string): void {
    this.hashes.delete(id);
  }
  listContentHashes(): Map<string, string> {
    return this.hashes;
  }
  close(): void {}
  points(): QdrantPoint[] {
    return this.chunks.map((c) =>
      qdrantPointFromChunk(c, this.hashes.get(sourceIdForChunk(c)) ?? ""),
    );
  }
}

// --- generation lock ---------------------------------------------------------------------------

export const qdrantGenerationLockPath = (storeRoot: string) =>
  join(storeRoot, ".search", "qdrant-reindex.lock");

const inProcessLocks = new Map<string, Promise<void>>();

async function acquireGenerationFileLock(
  storeRoot: string,
  timeoutMs: number,
  staleAfterMs: number,
  signal?: AbortSignal,
): Promise<() => void> {
  const path = qdrantGenerationLockPath(storeRoot);
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const timeout = timeoutMs > 0 ? timeoutMs : DEFAULT_LOCK_TIMEOUT_MS;
  const stale = staleAfterMs > 0 ? staleAfterMs : DEFAULT_LOCK_STALE_AFTER_MS;
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      writeFileSync(path, `pid=${process.pid}\ncreatedAt=${new Date().toISOString()}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      return () => rmSync(path, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    try {
      const m = /^pid=(\d+)/m.exec(readFileSync(path, "utf8"));
      const holder = m ? Number(m[1]) : 0;
      if (holder > 0 && !isProcessAlive(holder)) {
        rmSync(path, { force: true });
        continue;
      }
    } catch {
      // unreadable: fall back to the mtime window
    }
    try {
      if (Date.now() - statSync(path).mtimeMs > stale) {
        rmSync(path, { force: true });
        continue;
      }
    } catch {
      // gone
    }
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for Qdrant generation lock ${path}`);
    if (signal?.aborted) throw new Error("wait for Qdrant generation lock: context canceled");
    await sleep(50, signal);
  }
}

// --- generation records ------------------------------------------------------------------------

function generationRecord(
  generation: number,
  p: QdrantPointer,
  status: string,
  created: string,
  swapped: string,
  retired: string | undefined,
): QdrantGenerationRecord {
  return {
    generation: generation < 1 ? 1 : generation,
    collectionUUID: p.collectionUUID,
    collectionName: p.collectionName,
    schemaVersion: p.schemaVersion,
    chunkVersion: p.chunkVersion,
    embedding: p.embedding,
    owner: p.owner,
    status,
    chunkCount: p.chunkCount,
    createdAt: created,
    swappedAt: swapped,
    ...(retired ? { retiredAt: retired } : {}),
  } as QdrantGenerationRecord;
}

/** CleanupQdrantGenerations: hard count cap first, then TTL, only for exactly owned records. */
export async function cleanupQdrantGenerations(
  storeRoot: string,
  client: QdrantClient,
  active: QdrantPointer | undefined,
  keep: number,
  ttlMs: number,
  now: number,
): Promise<{ deleted: string[]; errors: Error[] }> {
  if (!client || !active || !active.owner.storeRootFingerprint) {
    return {
      deleted: [],
      errors: [new Error("qdrant cleanup refused: positive ownership proof is missing")],
    };
  }
  let records: QdrantGenerationRecord[];
  try {
    records = loadQdrantGenerations(storeRoot);
  } catch (err) {
    return { deleted: [], errors: [err as Error] };
  }
  const byName = new Map<string, QdrantGenerationRecord>();
  for (const r of records) {
    if (r.status === QDRANT_GENERATION_STATUS_INACTIVE) byName.set(r.collectionName, r);
  }
  const inactive = [...byName.values()].sort((a, b) => b.generation - a.generation);
  const deleted: string[] = [];
  const errors: Error[] = [];
  for (const [i, r] of inactive.entries()) {
    const owned =
      r.owner.storeRootFingerprint === active.owner.storeRootFingerprint &&
      r.owner.storeRootFingerprint === storeRootFingerprint(storeRoot);
    if (!owned) {
      errors.push(
        new Error(`qdrant cleanup refused for ${r.collectionName}: ownership proof mismatch`),
      );
      continue;
    }
    const expired = r.retiredAt != null && now >= Date.parse(r.retiredAt) + ttlMs;
    if (i < keep && !expired) continue;
    try {
      await client.deleteCollection(r.collectionName);
    } catch (err) {
      errors.push(
        new Error(
          `delete inactive Qdrant generation ${r.collectionName}: ${(err as Error).message}`,
        ),
      );
      continue;
    }
    deleted.push(r.collectionName);
  }
  if (deleted.length > 0) {
    const dropped = new Set(deleted);
    for (const r of records) {
      if (dropped.has(r.collectionName) && r.status === QDRANT_GENERATION_STATUS_INACTIVE) {
        r.status = QDRANT_GENERATION_STATUS_DELETED;
      }
    }
    try {
      saveQdrantGenerations(storeRoot, records);
    } catch (err) {
      errors.push(new Error(`record deleted Qdrant generations: ${(err as Error).message}`));
    }
  }
  return { deleted, errors };
}

export interface QdrantGenerationOptions {
  client: QdrantClient;
  now?: () => number;
  progress?: ReindexProgress;
  retentionGenerations?: number;
  retentionTtlMs?: number;
  lockTimeoutMs?: number;
  lockStaleAfterMs?: number;
  signal?: AbortSignal;
}

export interface QdrantGenerationResult {
  pointer: QdrantPointer;
  previous: QdrantPointer | undefined;
  cleanupDeleted: string[];
  cleanupErrors: Error[];
  historyError?: Error;
}

/** retentionFromResolution. */
export function retentionFromResolution(res: SemanticVectorStoreResolution): {
  keep: number;
  ttlMs: number;
} {
  const keep = res.retention.previousGenerations ?? DEFAULT_SEMANTIC_VECTOR_RETENTION_GENERATIONS;
  const parsed = parseGoDurationMs(res.retention.previousGenerationTTL ?? "");
  return { keep, ttlMs: parsed ?? DEFAULT_QDRANT_GENERATION_TTL_MS };
}

/**
 * ReindexQdrantGeneration: rebuild exclusively from canonical Knowns sources. It never opens the
 * legacy SQLite index.
 */
export async function reindexQdrantGeneration(
  storage: Storage,
  env: SearchEnvironment,
  embedder: EmbedderProvider,
  opts: QdrantGenerationOptions,
): Promise<QdrantGenerationResult> {
  const storeRoot = storage.store.root;
  const client = opts.client;
  // In-process mutual exclusion, then the cross-process lock file.
  const prior = inProcessLocks.get(storeRoot) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => {
    release = r;
  });
  inProcessLocks.set(
    storeRoot,
    prior.then(() => mine),
  );
  await prior;
  try {
    const releaseFile = await acquireGenerationFileLock(
      storeRoot,
      opts.lockTimeoutMs ?? 0,
      opts.lockStaleAfterMs ?? 0,
      opts.signal,
    );
    try {
      return await reindexLocked(storage, env, embedder, client, opts);
    } finally {
      releaseFile();
    }
  } finally {
    release();
  }
}

async function reindexLocked(
  storage: Storage,
  env: SearchEnvironment,
  embedder: EmbedderProvider,
  client: QdrantClient,
  opts: QdrantGenerationOptions,
): Promise<QdrantGenerationResult> {
  const storeRoot = storage.store.root;
  const now = opts.now ?? Date.now;
  const ttlMs =
    opts.retentionTtlMs && opts.retentionTtlMs > 0
      ? opts.retentionTtlMs
      : DEFAULT_QDRANT_GENERATION_TTL_MS;
  const keep =
    opts.retentionGenerations !== undefined && opts.retentionGenerations >= 0
      ? opts.retentionGenerations
      : DEFAULT_SEMANTIC_VECTOR_RETENTION_GENERATIONS;
  const previous = loadQdrantPointer(storeRoot);
  const embedding: QdrantEmbeddingPointer = {
    provider: "",
    model: embedder.modelConfig().name,
    dimensions: embedder.dimensions(),
    distance: QDRANT_DEFAULT_DISTANCE,
  };
  try {
    const cfg = loadSemanticRuntimeConfig(storage, env);
    embedding.provider = cfg.provider;
    embedding.model = cfg.modelId;
  } catch {
    // keep the embedder's own identity
  }
  let projectId = "";
  try {
    projectId = storage.config.load().id ?? "";
  } catch {
    projectId = "";
  }
  const next = newQdrantPointer(storeRoot, projectId, embedding);
  const created = new Date(now()).toISOString();
  try {
    await client.createCollection(next.collectionName, embedding.dimensions);
  } catch (err) {
    throw new Error(`create next Qdrant generation: ${(err as Error).message}`);
  }
  let activated = false;
  try {
    const stage = new StageStore(embedding.model);
    try {
      await new IndexService(storage, embedder, stage).reindex(opts.progress);
    } catch (err) {
      throw new Error(
        `build next Qdrant generation from canonical sources: ${(err as Error).message}`,
      );
    }
    const points = stage.points();
    for (const p of points) {
      if (
        payloadString(p.payload, PAYLOAD_CHUNK_ID) === "" ||
        payloadString(p.payload, PAYLOAD_SOURCE_ID) === "" ||
        payloadInt(p.payload, PAYLOAD_CHUNK_VERSION) !== CHUNK_VERSION ||
        payloadString(p.payload, PAYLOAD_CONTENT_HASH) === ""
      ) {
        throw new Error(
          "validate next Qdrant generation payload metadata: incomplete pointer payload",
        );
      }
    }
    try {
      await client.upsertPoints(next.collectionName, points);
    } catch (err) {
      throw new Error(`upsert next Qdrant generation: ${(err as Error).message}`);
    }
    let info: Awaited<ReturnType<QdrantClient["inspectCollection"]>>;
    try {
      info = await client.inspectCollection(next.collectionName);
    } catch (err) {
      throw new Error(`inspect next Qdrant generation: ${(err as Error).message}`);
    }
    let exactCount: number;
    try {
      exactCount = await client.countPoints(next.collectionName);
    } catch (err) {
      throw new Error(`count next Qdrant generation points: ${(err as Error).message}`);
    }
    if (
      !info.exists ||
      info.dimensions !== embedding.dimensions ||
      info.distance.toLowerCase() !== QDRANT_REST_DISTANCE_COSINE.toLowerCase() ||
      exactCount !== points.length
    ) {
      throw new Error(
        `validate next Qdrant generation: exists=${info.exists} dimensions=${info.dimensions}/${embedding.dimensions} distance="${info.distance}" points=${exactCount}/${points.length}`,
      );
    }
    const indexed = new Date(now()).toISOString();
    next.lastIndexedAt = indexed;
    next.chunkCount = points.length;
    try {
      saveQdrantPointer(storeRoot, next);
    } catch (err) {
      throw new Error(`activate next Qdrant generation: ${(err as Error).message}`);
    }
    activated = true;

    const indexedSourceIds = new Set<string>();
    for (const p of points) {
      const id = payloadString(p.payload, PAYLOAD_SOURCE_ID);
      if (id !== "") indexedSourceIds.add(id);
    }
    try {
      stampWatermarksFromGeneration(storeRoot, indexedSourceIds, indexed);
    } catch (err) {
      goLogf(
        `[search] rebuilt generation but could not stamp index watermarks: ${(err as Error).message}`,
      );
    }

    const result: QdrantGenerationResult = {
      pointer: next,
      previous,
      cleanupDeleted: [],
      cleanupErrors: [],
    };
    let records: QdrantGenerationRecord[];
    try {
      records = loadQdrantGenerations(storeRoot);
    } catch (err) {
      result.historyError = new Error(
        `active pointer was swapped but generation history could not be loaded; cleanup skipped: ${(err as Error).message}`,
      );
      throw Object.assign(result.historyError, { result });
    }
    let generation = 1;
    for (const r of records) if (r.generation >= generation) generation = r.generation + 1;
    if (previous && generation === 1) generation = 2;
    const retired = indexed;
    let updatedPrevious = false;
    records = records.map((r) => {
      if (r.status !== QDRANT_GENERATION_STATUS_ACTIVE) return r;
      let out: QdrantGenerationRecord = {
        ...r,
        status: QDRANT_GENERATION_STATUS_INACTIVE,
        retiredAt: retired,
        swappedAt: indexed,
      };
      if (previous && r.collectionName === previous.collectionName) {
        out = generationRecord(
          r.generation,
          previous,
          QDRANT_GENERATION_STATUS_INACTIVE,
          r.createdAt,
          indexed,
          retired,
        );
        updatedPrevious = true;
      }
      return out;
    });
    if (previous && !updatedPrevious) {
      records.push(
        generationRecord(
          generation - 1,
          previous,
          QDRANT_GENERATION_STATUS_INACTIVE,
          created,
          indexed,
          retired,
        ),
      );
    }
    records.push(
      generationRecord(
        generation,
        next,
        QDRANT_GENERATION_STATUS_ACTIVE,
        created,
        indexed,
        undefined,
      ),
    );
    try {
      saveQdrantGenerations(storeRoot, records);
    } catch (err) {
      result.historyError = new Error(
        `active pointer was swapped but generation history could not record active collection; cleanup skipped: ${(err as Error).message}`,
      );
      throw Object.assign(result.historyError, { result });
    }
    const cleanup = await cleanupQdrantGenerations(storeRoot, client, next, keep, ttlMs, now());
    result.cleanupDeleted = cleanup.deleted;
    result.cleanupErrors = cleanup.errors;
    return result;
  } finally {
    if (!activated) {
      try {
        await client.deleteCollection(next.collectionName);
      } catch {
        // best effort
      }
    }
  }
}

/** PurgeQdrantCollections: bypasses retention but fails closed unless every target is owned. */
export async function purgeQdrantCollections(
  storeRoot: string,
  client: QdrantClient,
): Promise<string[]> {
  const pointer = loadQdrantPointer(storeRoot);
  if (
    !pointer ||
    !pointer.owner.storeRootFingerprint ||
    pointer.owner.storeRootFingerprint !== storeRootFingerprint(storeRoot)
  ) {
    throw new Error("qdrant purge refused: positive ownership proof is missing");
  }
  const targets = new Set<string>([pointer.collectionName]);
  for (const r of loadQdrantGenerations(storeRoot)) {
    if (r.owner.storeRootFingerprint !== pointer.owner.storeRootFingerprint) {
      throw new Error(`qdrant purge refused for ${r.collectionName}: ownership proof mismatch`);
    }
    targets.add(r.collectionName);
  }
  const deleted: string[] = [];
  for (const name of [...targets].sort()) {
    try {
      await client.deleteCollection(name);
    } catch (err) {
      throw new Error(
        `purge Qdrant collection ${name} after deleting ${deleted.length} collections: ${(err as Error).message}`,
      );
    }
    deleted.push(name);
  }
  return deleted;
}
