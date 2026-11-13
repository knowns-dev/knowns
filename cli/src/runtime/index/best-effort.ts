// Port of internal/search/sync.go: the BestEffort* hooks every write path calls after a doc, task,
// memory or decision mutation. With the Qdrant backend, task and doc changes become a durable,
// proof-checked Qdrant intent (plus a pending watermark); everything else is queued as a runtime
// job, which starts the shared daemon. Under KNOWNS_RUNTIME_INLINE=1 Go falls back to a debounced
// in-process IndexService that a short-lived CLI never outlives; wiring/runtime.ts installs that
// fallback, which writes the legacy SQLite index through runtime/index/entity.ts.

import { SEMANTIC_VECTOR_BACKEND_QDRANT } from "../../models/config.ts";
import { resolveEffectiveVectorStore, type SearchEnvironment } from "../../search/config.ts";
import type { Storage } from "../../storage/adapters.ts";
import { createStorage } from "../../storage/adapters.ts";
import { globalSemanticStoreRoot, Store } from "../../storage/core/store.ts";
import { canonicalDocHash as canonicalDocHashOf } from "../../storage/history/entities.ts";
import {
  enqueueJob,
  enqueueQdrantIntent,
  goLogf,
  type JobKind,
  type QdrantIntent,
  shouldBypassDaemon,
} from "../queue.ts";
import {
  currentPublicQdrantIntent,
  markQdrantIntentPending,
  proveQdrantIntent,
  removalIntentFromHistoryOrPurge,
} from "./qdrant-intent.ts";

export interface BestEffortDeps {
  env: () => SearchEnvironment;
  /** Where the non-queue fallback runs (Go: scheduleBestEffort). Defaults to nothing. */
  fallback?: (storage: Storage, action: string, target: string) => void;
}

let deps: BestEffortDeps | undefined;

export function configureBestEffort(next: BestEffortDeps | undefined): void {
  deps = next;
}

function env(): SearchEnvironment {
  if (!deps) throw new Error("search best-effort hooks are not configured");
  return deps.env();
}

function usesQdrant(storage: Storage): boolean {
  return resolveEffectiveVectorStore(storage, env()).backend === SEMANTIC_VECTOR_BACKEND_QDRANT;
}

function enqueueRuntimeJob(storage: Storage, kind: JobKind, target: string, action: string): void {
  if (shouldBypassDaemon()) {
    deps?.fallback?.(storage, action, target);
    return;
  }
  try {
    enqueueJob(storage.store.root, kind, target);
  } catch (err) {
    goLogf(`[search] runtime queue unavailable for ${kind} ${target}: ${(err as Error).message}`);
    deps?.fallback?.(storage, action, target);
  }
}

/** Queues the proven intent; true means the caller must not run the legacy fallback. */
function qdrantBestEffortIntent(
  storage: Storage,
  entityType: string,
  target: string,
  remove: boolean,
): boolean {
  if (!usesQdrant(storage)) return false;
  const root = storage.store.root;
  let intent: QdrantIntent;
  try {
    intent = currentPublicQdrantIntent(storage, entityType, target, remove);
  } catch (err) {
    goLogf(
      `[search] could not build qdrant ${entityType} intent for ${target}: ${(err as Error).message}`,
    );
    return true;
  }
  let ok = false;
  let proofErr: unknown;
  try {
    ok = proveQdrantIntent(storage, intent);
  } catch (err) {
    proofErr = err;
  }
  if (proofErr || !ok) {
    goLogf(
      `[search] could not prove qdrant ${entityType} intent for ${target}: ${proofErr ? (proofErr as Error).message : "<nil>"}`,
    );
    return true;
  }
  try {
    markQdrantIntentPending(root, intent);
  } catch (err) {
    goLogf(
      `[search] could not persist qdrant ${entityType} readiness for ${target}: ${(err as Error).message}`,
    );
  }
  try {
    enqueueQdrantIntent(root, intent);
  } catch (err) {
    goLogf(
      `[search] could not queue qdrant ${entityType} intent for ${target}: ${(err as Error).message}`,
    );
  }
  return true;
}

export function bestEffortIndexTask(storage: Storage, taskId: string): void {
  if (qdrantBestEffortIntent(storage, "task", taskId, false)) return;
  enqueueRuntimeJob(storage, "index-task", taskId, "index-task");
}

export function bestEffortRemoveTask(storage: Storage, taskId: string): void {
  if (qdrantBestEffortIntent(storage, "task", taskId, true)) return;
  enqueueRuntimeJob(storage, "remove-task", taskId, "remove-task");
}

export function bestEffortIndexDoc(storage: Storage, docPath: string): void {
  if (qdrantBestEffortIntent(storage, "doc", docPath, false)) return;
  enqueueRuntimeJob(storage, "index-doc", docPath, "index-doc");
}

export function bestEffortRemoveDoc(storage: Storage, docPath: string): void {
  if (qdrantBestEffortIntent(storage, "doc", docPath, true)) return;
  enqueueRuntimeJob(storage, "remove-doc", docPath, "remove-doc");
}

const docRel = (p: string) => `docs/${p.replace(/^docs\//, "").replace(/\.md$/, "")}.md`;

/** BestEffortRemoveDocID: stable doc identity for Qdrant removals; no proof, no mutation. */
export function bestEffortRemoveDocID(storage: Storage, docId: string, docPath: string): void {
  if (usesQdrant(storage)) {
    const root = storage.store.root;
    let intent: QdrantIntent;
    try {
      intent = removalIntentFromHistoryOrPurge(storage, "doc", docId, docRel(docPath), "");
    } catch (err) {
      goLogf(`[search] could not prove qdrant doc removal ${docId}: ${(err as Error).message}`);
      return;
    }
    intent.batchId = "public-hook";
    let ok = false;
    let proofErr: unknown;
    try {
      ok = proveQdrantIntent(storage, intent);
    } catch (err) {
      proofErr = err;
    }
    if (proofErr || !ok) {
      goLogf(
        `[search] could not prove qdrant doc removal ${docId}: ${proofErr ? (proofErr as Error).message : "<nil>"}`,
      );
      return;
    }
    try {
      markQdrantIntentPending(root, intent);
    } catch (err) {
      goLogf(`[search] could not persist qdrant doc removal readiness: ${(err as Error).message}`);
    }
    try {
      enqueueQdrantIntent(root, intent);
    } catch (err) {
      goLogf(`[search] could not queue qdrant doc removal: ${(err as Error).message}`);
    }
    return;
  }
  bestEffortRemoveDoc(storage, docPath);
}

/** BestEffortRenameDoc: one stable-id Qdrant intent deletes the old source and upserts the new. */
export function bestEffortRenameDoc(
  storage: Storage,
  docId: string,
  oldPath: string,
  newPath: string,
): void {
  if (usesQdrant(storage)) {
    const root = storage.store.root;
    let doc: ReturnType<Storage["docs"]["get"]> | undefined;
    let getErr: unknown;
    try {
      doc = storage.docs.get(newPath);
    } catch (err) {
      getErr = err;
    }
    if (!doc || doc.id !== docId) {
      goLogf(
        `[search] could not resolve renamed qdrant doc ${docId}: ${getErr ? (getErr as Error).message : "<nil>"}`,
      );
      return;
    }
    const records = (() => {
      try {
        return storage.history.readPreview("doc", docId).records ?? [];
      } catch {
        return [];
      }
    })();
    const head = records[records.length - 1];
    if (!head) {
      goLogf(`[search] renamed qdrant doc lacks durable history ${docId}`);
      return;
    }
    const intent: QdrantIntent = {
      entityType: "doc",
      entityId: docId,
      revision: head.revision,
      operation: "rename",
      canonicalHash: canonicalDocHashOf(doc),
      path: docRel(newPath),
      previousPath: docRel(oldPath),
      batchId: "public-hook",
      generation: 0,
    };
    let ok = false;
    let proofErr: unknown;
    try {
      ok = proveQdrantIntent(storage, intent);
    } catch (err) {
      proofErr = err;
    }
    if (proofErr || !ok) {
      goLogf(
        `[search] could not prove renamed qdrant doc ${docId}: ${proofErr ? (proofErr as Error).message : "<nil>"}`,
      );
      return;
    }
    try {
      markQdrantIntentPending(root, intent);
    } catch (err) {
      goLogf(`[search] could not persist renamed qdrant doc readiness: ${(err as Error).message}`);
    }
    try {
      enqueueQdrantIntent(root, intent);
    } catch (err) {
      goLogf(`[search] could not queue renamed qdrant doc: ${(err as Error).message}`);
    }
    return;
  }
  bestEffortRemoveDoc(storage, oldPath);
  bestEffortIndexDoc(storage, newPath);
}

/** memoryIndexTarget: a global memory is indexed in the machine-level semantic store. */
function memoryIndexTarget(storage: Storage, memoryId: string): Storage {
  let layer: string | undefined;
  try {
    layer = storage.memory.get(memoryId).layer;
  } catch {
    return storage;
  }
  if (layer === "global") return createStorage(Store.open(globalSemanticStoreRoot()));
  return storage;
}

export function bestEffortIndexMemory(storage: Storage, memoryId: string): void {
  const target = memoryIndexTarget(storage, memoryId);
  enqueueRuntimeJob(target, "index-memory", memoryId, "index-memory");
}

export function bestEffortRemoveMemory(storage: Storage, memoryId: string): void {
  const target = memoryIndexTarget(storage, memoryId);
  enqueueRuntimeJob(target, "remove-memory", memoryId, "remove-memory");
}

export function bestEffortIndexDecision(storage: Storage, decisionId: string): void {
  enqueueRuntimeJob(storage, "index-decision", decisionId, "index-decision");
}

export function bestEffortRemoveDecision(storage: Storage, decisionId: string): void {
  enqueueRuntimeJob(storage, "remove-decision", decisionId, "remove-decision");
}
