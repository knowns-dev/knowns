// Port of ExecuteQdrantReconciliation (internal/search/qdrant_reconcile.go): targeted, per-entity
// Qdrant maintenance. It consumes a durable content-free intent, proves the active pointer still
// owns a reachable compatible collection, rereads canonical state, deletes the exact old sources
// and upserts only the affected entity's chunks. It never creates a collection or swaps a pointer.

import { SEMANTIC_VECTOR_BACKEND_QDRANT } from "../../models/config.ts";
import { chunkDocument, chunkTask } from "../../search/chunker.ts";
import { resolveEffectiveVectorStore, type SearchEnvironment } from "../../search/config.ts";
import { contentHash, taskContentForHash } from "../../search/hash.ts";
import { type QdrantClient, qdrantPointFromChunk } from "../../search/qdrant/client.ts";
import {
  collectionNameFromUUID,
  loadQdrantPointer,
  QDRANT_POINTER_SCHEMA_VERSION,
  type QdrantPointer,
  storeRootFingerprint,
} from "../../search/qdrant/pointer.ts";
import { QdrantVectorStore, qdrantClientForStore } from "../../search/qdrant/store.ts";
import { semanticIndexExpectationForStore } from "../../search/readiness.ts";
import { openSemanticSession } from "../../search/runtime.ts";
import { CHUNK_VERSION, type Chunk, type EmbedderProvider } from "../../search/types.ts";
import type { Storage } from "../../storage/adapters.ts";
import { canonicalDocHash, canonicalTaskHash } from "../../storage/history/entities.ts";
import { ensureManagedQdrant } from "../qdrant.ts";
import { nowString, type QdrantIntent } from "../queue.ts";
import {
  normalizeIntentDocPath,
  proveQdrantIntent,
  updateQdrantWatermark,
} from "./qdrant-intent.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** validateTargetedCollection: each rejection names the field that failed. */
export async function validateTargetedCollection(
  storage: Storage,
  env: SearchEnvironment,
  pointer: QdrantPointer | undefined,
  client: QdrantClient,
): Promise<void> {
  if (!pointer) throw new Error("qdrant active pointer is missing (run: knowns search index)");
  if (pointer.backend !== SEMANTIC_VECTOR_BACKEND_QDRANT) {
    throw new Error(
      `qdrant active pointer backend = "${pointer.backend}", want "${SEMANTIC_VECTOR_BACKEND_QDRANT}"`,
    );
  }
  if (pointer.schemaVersion !== QDRANT_POINTER_SCHEMA_VERSION) {
    throw new Error(
      `qdrant active pointer schema version = ${pointer.schemaVersion}, want ${QDRANT_POINTER_SCHEMA_VERSION}`,
    );
  }
  if (pointer.chunkVersion !== CHUNK_VERSION) {
    throw new Error(
      `qdrant active pointer chunk version = ${pointer.chunkVersion}, want ${CHUNK_VERSION}`,
    );
  }
  if (pointer.collectionUUID.trim() === "") {
    throw new Error("qdrant active pointer is missing collectionUUID");
  }
  if (pointer.collectionName !== collectionNameFromUUID(pointer.collectionUUID)) {
    throw new Error(
      `qdrant active pointer collectionName "${pointer.collectionName}" does not match collectionUUID ${pointer.collectionUUID}`,
    );
  }
  if (!UUID_RE.test(pointer.collectionUUID)) {
    throw new Error("qdrant active pointer collectionUUID is invalid");
  }
  if (pointer.owner.storeRootFingerprint !== storeRootFingerprint(storage.store.root)) {
    throw new Error("qdrant active pointer ownership mismatch");
  }
  const info = await client.inspectCollection(pointer.collectionName);
  if (!info.exists) throw new Error("qdrant active collection is unavailable");
  const expectation = semanticIndexExpectationForStore(storage, env);
  if (expectation.model !== "" && pointer.embedding.model !== expectation.model) {
    throw new Error("qdrant active collection model mismatch");
  }
  if (expectation.dimensions > 0 && pointer.embedding.dimensions !== expectation.dimensions) {
    throw new Error("qdrant active pointer dimensions mismatch");
  }
  if (info.dimensions <= 0 || pointer.embedding.dimensions !== info.dimensions) {
    throw new Error("qdrant active collection dimensions mismatch");
  }
  if (info.status !== "" && info.status.toLowerCase() === "red") {
    throw new Error("qdrant active collection is unhealthy");
  }
  if (
    info.distance !== "" &&
    info.distance.toLowerCase() !== (pointer.embedding.distance ?? "").toLowerCase()
  ) {
    throw new Error("qdrant active collection distance mismatch");
  }
}

async function deleteSource(
  client: QdrantClient,
  collection: string,
  source: string,
): Promise<void> {
  if (!client.deletePointsBySource) {
    throw new Error("qdrant client does not support exact source deletion");
  }
  await client.deletePointsBySource(collection, source);
}

async function reconcileSource(
  client: QdrantClient,
  collection: string,
  previousSource: string,
  source: string,
  chunks: Chunk[],
  semanticHash: string,
): Promise<void> {
  if (previousSource !== "" && previousSource !== source) {
    await deleteSource(client, collection, previousSource);
  }
  await deleteSource(client, collection, source);
  await client.upsertPoints(
    collection,
    chunks.map((c) => qdrantPointFromChunk(c, semanticHash)),
  );
}

async function reconcileDelete(
  storage: Storage,
  pointer: QdrantPointer,
  client: QdrantClient,
  intent: QdrantIntent,
  sourceIn: string,
  now: string,
): Promise<void> {
  let source = sourceIn;
  if (intent.entityType === "doc") source = `doc:${normalizeIntentDocPath(intent.path ?? "")}`;
  await deleteSource(client, pointer.collectionName, source);
  if (intent.previousPath && intent.previousPath !== intent.path) {
    await deleteSource(
      client,
      pointer.collectionName,
      `doc:${normalizeIntentDocPath(intent.previousPath)}`,
    );
  }
  updateQdrantWatermark(storage.store.root, intent, "", now);
}

async function embedderChunks(embedder: EmbedderProvider, chunks: Chunk[]): Promise<Chunk[]> {
  if (chunks.length === 0) return chunks;
  let vecs: Float32Array[];
  try {
    vecs = await embedder.embedDocumentBatch(chunks.map((c) => c.content));
  } catch (err) {
    throw new Error(`embed targeted chunks: ${(err as Error).message}`);
  }
  if (vecs.length !== chunks.length) throw new Error("embed targeted chunks: <nil>");
  for (const [i, c] of chunks.entries()) c.embedding = vecs[i];
  return chunks;
}

function maxTokensOf(embedder: EmbedderProvider): number {
  const cfg = embedder.modelConfig();
  return cfg.maxTokens > 0 ? cfg.maxTokens : 512;
}

export interface ReconcileDeps {
  now?: () => string;
  /** Replaces the managed-process start (tests). */
  ensureManaged?: (res: ReturnType<typeof resolveEffectiveVectorStore>) => Promise<void>;
}

export async function executeQdrantReconciliation(
  storage: Storage,
  env: SearchEnvironment,
  intent: QdrantIntent,
  deps: ReconcileDeps = {},
): Promise<void> {
  const storeRoot = storage.store.root;
  const now = deps.now ?? (() => nowString());
  if (!proveQdrantIntent(storage, intent)) return;
  const resolved = resolveEffectiveVectorStore(storage, env);
  if (!resolved.enabled || resolved.backend !== SEMANTIC_VECTOR_BACKEND_QDRANT) return;
  const pointer = loadQdrantPointer(storeRoot);
  if (!pointer) return;
  await (deps.ensureManaged ?? ensureManagedQdrant)(resolved);
  const client = qdrantClientForStore(storage, env);
  await validateTargetedCollection(storage, env, pointer, client);
  const session = openSemanticSession(storage, env);
  try {
    if (!(session.vecStore instanceof QdrantVectorStore)) {
      throw new Error("targeted reconciliation requires active Qdrant vector store");
    }
    let chunks: Chunk[];
    let sourceId: string;
    let canonicalHash: string;
    let semanticHash: string;
    const embedder = session.embedder;
    const deleteOp = intent.operation === "delete" || intent.operation === "hard_delete";
    switch (intent.entityType) {
      case "task": {
        if (deleteOp) {
          return await reconcileDelete(
            storage,
            pointer,
            client,
            intent,
            `task:${intent.entityId}`,
            now(),
          );
        }
        const task = storage.tasks.get(intent.entityId);
        canonicalHash = canonicalTaskHash(task);
        semanticHash = contentHash(taskContentForHash(task));
        if (intent.canonicalHash && canonicalHash !== intent.canonicalHash) {
          throw new Error(`qdrant intent stale for task ${intent.entityId}`);
        }
        chunks = await embedderChunks(
          embedder,
          chunkTask(task, maxTokensOf(embedder), embedder.getTokenizer()).chunks,
        );
        sourceId = `task:${intent.entityId}`;
        break;
      }
      case "doc": {
        if (deleteOp) {
          return await reconcileDelete(
            storage,
            pointer,
            client,
            intent,
            `doc:${intent.path ?? ""}`,
            now(),
          );
        }
        const docPath = normalizeIntentDocPath(intent.path ?? "");
        const doc = storage.docs.get(docPath);
        canonicalHash = canonicalDocHash(doc);
        semanticHash = contentHash(`${doc.title}\n${doc.description ?? ""}\n${doc.content ?? ""}`);
        if (intent.canonicalHash && canonicalHash !== intent.canonicalHash) {
          throw new Error(`qdrant intent stale for doc ${intent.path ?? ""}`);
        }
        chunks = await embedderChunks(
          embedder,
          chunkDocument(
            doc.content ?? "",
            doc.path,
            doc.title,
            doc.description ?? "",
            maxTokensOf(embedder),
            embedder.getTokenizer(),
          ).chunks,
        );
        sourceId = `doc:${docPath}`;
        break;
      }
      default:
        throw new Error(`unsupported qdrant entity type "${intent.entityType}"`);
    }
    let previousSource = "";
    if (
      intent.operation === "rename" &&
      intent.previousPath &&
      intent.previousPath !== intent.path
    ) {
      previousSource = `doc:${normalizeIntentDocPath(intent.previousPath)}`;
    }
    await reconcileSource(
      client,
      pointer.collectionName,
      previousSource,
      sourceId,
      chunks,
      semanticHash,
    );
    updateQdrantWatermark(storeRoot, intent, canonicalHash, now());
  } finally {
    await session.close();
  }
}
