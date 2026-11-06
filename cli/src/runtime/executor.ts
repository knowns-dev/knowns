// Port of search.ExecuteRuntimeJob (internal/search/runtime_jobs.go): what the shared runtime
// daemon does for each queued job kind. Qdrant is the only index writer in the TypeScript build, so
// task and doc jobs run as targeted reconciliations and a reindex builds a new generation;
// memory and decision jobs have nothing to write (Go's Qdrant store discards them too) and the
// non-Qdrant backends fail with the vector backend's "not available" error.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildSearchEnvironment } from "../domain/searchenv/index.ts";
import {
  SEMANTIC_VECTOR_BACKEND_QDRANT,
  SEMANTIC_VECTOR_STORE_MODE_MANAGED,
} from "../models/config.ts";
import {
  resolveEffectiveVectorStore,
  type SearchEnvironment,
  semanticRuntimeDisabledReason,
} from "../search/config.ts";
import {
  errorChainHas,
  SemanticNotConfiguredError,
  SemanticRuntimeDisabledError,
} from "../search/errors.ts";
import { goJson } from "../search/json.ts";
import { qdrantClientForStore } from "../search/qdrant/store.ts";
import { openSemanticSession } from "../search/runtime.ts";
import { SQLiteVectorStore } from "../search/sqlite-store.ts";
import { createStorage, type Storage } from "../storage/adapters.ts";
import { Store } from "../storage/core/store.ts";
import { applySqliteIndexAction, openSqliteSemantic } from "./index/entity.ts";
import { IndexService } from "./index/index-service.ts";
import { currentQdrantIntent } from "./index/qdrant-intent.ts";
import { executeQdrantReconciliation } from "./index/reconcile.ts";
import { reindexQdrantGeneration, retentionFromResolution } from "./index/reindex.ts";
import {
  configFromResolution,
  ensureManagedQdrant,
  installQdrant,
  QdrantManager,
} from "./qdrant.ts";
import {
  enqueueJob,
  enqueueQdrantIntent,
  type Job,
  nowString,
  type ReloadStatus,
  reportProgress,
  runtimeRoot,
  type WatcherFactory,
} from "./queue.ts";

export interface RuntimeSeams {
  /** startRuntimeWatcher: the project knowledge watcher the daemon runs for watch leases (TSR-MBTAN6). */
  watcherFactory?: WatcherFactory;
  /** Long-lived daemon services (store sync) and their keep-alive probe. */
  services?: ((signal: AbortSignal) => Promise<void>)[];
  keepAlive?: () => boolean;
  /** FilesystemReconciler.ReconcileLifecycle for the reconcile-knowledge job (TSR-MBTAN6). */
  reconcileKnowledge?: (
    storage: Storage,
    onChanged: (result: ReconcileResult) => void,
  ) => Promise<void>;
  env?: () => SearchEnvironment;
  ensureManaged?: typeof ensureManagedQdrant;
}

export interface ReconcileResult {
  entityType: string;
  entityId: string;
  operation: string;
  path: string;
  currentPath?: string;
  previousPath?: string;
  newHash?: string;
  revision: number;
  batchId?: string;
}

export const runtimeSeams: RuntimeSeams = {};

/**
 * runtimeIndexEnqueuer: queues indexing for one reconciled entity (Go internal/cli/runtime.go): a
 * job for the local index, or a Qdrant intent when Qdrant is the backend.
 */
export function runtimeIndexEnqueuer(storeRoot: string): (result: ReconcileResult) => void {
  return (result) => {
    const storage = createStorage(Store.open(storeRoot));
    const removed = result.operation === "delete" || result.operation === "hard_delete";
    if (resolveEffectiveVectorStore(storage, envOf()).backend !== SEMANTIC_VECTOR_BACKEND_QDRANT) {
      let kind: Parameters<typeof enqueueJob>[1] = removed ? "remove-doc" : "index-doc";
      let target = result.path
        .replaceAll("\\", "/")
        .replace(/^docs\//, "")
        .replace(/\.md$/, "");
      if (result.entityType === "task") {
        kind = removed ? "remove-task" : "index-task";
        target = result.entityId;
      }
      enqueueJob(storeRoot, kind, target);
      return;
    }
    enqueueQdrantIntent(storeRoot, {
      entityType: result.entityType,
      entityId: result.entityId,
      revision: result.revision,
      operation: result.operation,
      canonicalHash: result.newHash ?? "",
      path: result.currentPath || result.path,
      previousPath: result.previousPath ?? "",
      batchId: result.batchId ?? "",
      generation: 0,
    });
  };
}

function envOf(): SearchEnvironment {
  return runtimeSeams.env ? runtimeSeams.env() : buildSearchEnvironment();
}

const semanticRuntimeStatusPath = () => join(runtimeRoot(), "semantic-status.json");

/** PersistDefaultSemanticRuntimeStatus: what `runtime ps` reads back while the daemon runs. */
let reloadMeta: { lastReloadAt?: string; generation?: number; requestId?: string } = {};

/** ReloadDefaultSemanticRuntime: remember the reload and republish the status. */
export function reloadSemanticRuntime(reload: ReloadStatus): void {
  reloadMeta = {
    ...(reload.processedAt ? { lastReloadAt: reload.processedAt } : {}),
    ...(reload.generation ? { generation: reload.generation } : {}),
    ...(reload.requestId ? { requestId: reload.requestId } : {}),
  };
  persistSemanticRuntimeStatus();
}

export function persistSemanticRuntimeStatus(reload: typeof reloadMeta = reloadMeta): void {
  const path = semanticRuntimeStatusPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const { disabled, reason } = semanticRuntimeDisabledReason(process.env);
  writeFileSync(
    path,
    goJson(
      {
        updatedAt: nowString(),
        status: {
          enabled: !disabled,
          ...(reason ? { disabledBy: reason } : {}),
          idleTimeout: 120_000_000_000,
          lastReloadAt: reload?.lastReloadAt ?? "0001-01-01T00:00:00Z",
          ...(reload?.generation ? { reloadGeneration: reload.generation } : {}),
          ...(reload?.requestId ? { reloadRequestId: reload.requestId } : {}),
        },
      },
      { indent: 2 },
    ),
    { mode: 0o644 },
  );
}

function sessionSkippable(err: unknown): boolean {
  return (
    errorChainHas(err, SemanticNotConfiguredError) ||
    errorChainHas(err, SemanticRuntimeDisabledError)
  );
}

export async function executeRuntimeJob(storeRoot: string, job: Job): Promise<void> {
  try {
    await executeInner(storeRoot, job);
  } finally {
    try {
      persistSemanticRuntimeStatus();
    } catch {
      // best effort
    }
  }
}

async function executeInner(storeRoot: string, job: Job): Promise<void> {
  const storage = createStorage(Store.open(storeRoot));
  const env = envOf();
  const target = job.target ?? "";
  const resolved = () => resolveEffectiveVectorStore(storage, env);
  const deps = runtimeSeams.ensureManaged ? { ensureManaged: runtimeSeams.ensureManaged } : {};

  if (resolved().backend === SEMANTIC_VECTOR_BACKEND_QDRANT) {
    switch (job.kind) {
      case "index-task":
      case "remove-task": {
        let intent: ReturnType<typeof currentQdrantIntent>;
        try {
          intent = currentQdrantIntent(storage, "task", target, job.kind === "remove-task", "");
        } catch (err) {
          throw new Error(`build targeted qdrant task intent: ${(err as Error).message}`);
        }
        return executeQdrantReconciliation(storage, env, intent, deps);
      }
      case "index-doc":
      case "remove-doc": {
        let intent: ReturnType<typeof currentQdrantIntent>;
        try {
          intent = currentQdrantIntent(storage, "doc", target, job.kind === "remove-doc", "");
        } catch (err) {
          throw new Error(`build targeted qdrant doc intent: ${(err as Error).message}`);
        }
        return executeQdrantReconciliation(storage, env, intent, deps);
      }
      default:
        break;
    }
  }

  switch (job.kind) {
    case "index-task":
    case "index-doc":
    case "remove-task":
    case "remove-doc":
    case "index-memory":
    case "remove-memory":
    case "index-decision":
    case "remove-decision":
      return executeEntity(storage, env, `${job.kind} ${target}`, job.kind, target);
    case "semantic-search":
      throw new Error("unsupported runtime job kind: semantic-search");
    case "reconcile-knowledge": {
      const reconcile = runtimeSeams.reconcileKnowledge;
      if (!reconcile) throw new Error("knowledge reconciliation is not available in this build");
      return reconcile(storage, (result) => {
        if (resolved().backend !== SEMANTIC_VECTOR_BACKEND_QDRANT) {
          const removed = result.operation === "delete" || result.operation === "hard_delete";
          let kind: Parameters<typeof enqueueJob>[1] = removed ? "remove-doc" : "index-doc";
          let t = result.path;
          if (result.entityType === "task") {
            kind = removed ? "remove-task" : "index-task";
            t = result.entityId;
          }
          enqueueJob(storeRoot, kind, t);
          return;
        }
        enqueueQdrantIntent(storeRoot, {
          entityType: result.entityType,
          entityId: result.entityId,
          revision: result.revision,
          operation: result.operation,
          canonicalHash: result.newHash ?? "",
          path: result.currentPath || result.path,
          previousPath: result.previousPath ?? "",
          batchId: result.batchId ?? "",
          generation: 0,
        });
      });
    }
    case "reconcile-qdrant":
      if (!job.intent) throw new Error("qdrant reconciliation job has no intent");
      return executeQdrantReconciliation(storage, env, job.intent, deps);
    case "reindex-search":
      return executeReindex(storage, env, storeRoot, job);
    case "index-file":
    case "remove-file":
    case "index-all-files":
      return;
    default:
      throw new Error(`unsupported runtime job kind: ${String(job.kind)}`);
  }
}

async function executeEntity(
  storage: Storage,
  env: SearchEnvironment,
  action: string,
  kind: Job["kind"],
  target: string,
): Promise<void> {
  // A non-Qdrant backend opens the legacy SQLite session and writes its rows, exactly as the
  // in-process indexer does (Go: session.IndexService(store)).
  if (resolveEffectiveVectorStore(storage, env).backend !== SEMANTIC_VECTOR_BACKEND_QDRANT) {
    let sem: Awaited<ReturnType<typeof openSqliteSemantic>>;
    try {
      sem = await openSqliteSemantic(storage, env);
    } catch (err) {
      if (sessionSkippable(err)) return;
      throw new Error(`could not ${action}: ${(err as Error).message}`);
    }
    return applySqliteIndexAction(storage, sem, kind, target);
  }
  let session: ReturnType<typeof openSemanticSession>;
  try {
    session = openSemanticSession(storage, env);
  } catch (err) {
    if (sessionSkippable(err)) return;
    throw new Error(`could not ${action}: ${(err as Error).message}`);
  }
  try {
    // The Qdrant store has nothing to write for memories and decisions (Go embeds and discards).
    // Only the lookup's failure is observable.
    if (kind === "index-memory") {
      try {
        storage.memory.getInLayer(target, "project");
      } catch {
        storage.memory.getInLayer(target, "global");
      }
    } else if (kind === "index-decision") {
      storage.decisions.get(target);
    }
  } finally {
    await session.close();
  }
}

async function executeReindex(
  storage: Storage,
  env: SearchEnvironment,
  storeRoot: string,
  job: Job,
): Promise<void> {
  const resolved = resolveEffectiveVectorStore(storage, env);
  if (
    resolved.backend === SEMANTIC_VECTOR_BACKEND_QDRANT &&
    resolved.mode === SEMANTIC_VECTOR_STORE_MODE_MANAGED
  ) {
    const mgr = new QdrantManager(configFromResolution(resolved));
    try {
      await installQdrant(mgr.paths().root);
    } catch (err) {
      throw new Error(`install managed Qdrant: ${(err as Error).message}`);
    }
    try {
      await (runtimeSeams.ensureManaged ?? ensureManagedQdrant)(resolved);
    } catch (err) {
      throw new Error(`start managed Qdrant: ${(err as Error).message}`);
    }
  }
  let session: ReturnType<typeof openSemanticSession>;
  try {
    session = openSemanticSession(storage, env);
  } catch (err) {
    if (sessionSkippable(err)) return;
    throw err;
  }
  try {
    const res = resolveEffectiveVectorStore(storage, env);
    const progress = (phase: string, current: number, total: number) => {
      try {
        reportProgress(storeRoot, job.id, phase, current, total);
      } catch {
        // progress is advisory
      }
    };
    if (res.backend !== SEMANTIC_VECTOR_BACKEND_QDRANT) {
      // session.Engine(store).Reindex: the SQLite index is rebuilt in place.
      if (!(session.vecStore instanceof SQLiteVectorStore)) {
        throw new Error(`reindex: ${res.backend} vector store is not writable`);
      }
      await new IndexService(storage, session.embedder, session.vecStore).reindex(progress);
      return;
    }
    const client = qdrantClientForStore(storage, env);
    const { keep, ttlMs } = retentionFromResolution(res);
    await reindexQdrantGeneration(storage, env, session.embedder, {
      client,
      retentionGenerations: keep,
      retentionTtlMs: ttlMs,
      progress,
    });
  } finally {
    await session.close();
  }
}
