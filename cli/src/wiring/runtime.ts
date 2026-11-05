// Wiring for the runtime queue and background indexing (TSR-2MPMDK). Fills the seams the command
// layers expose so a doc, task, memory or decision write queues the same runtime jobs (and starts
// the same shared daemon) as the Go 0.34.1 binary:
//
//   searchRuntimeHooks.enqueueReindex   degraded-search bootstrap (domain/searchenv)
//   docHooks.indexDoc/removeDocID/renameDoc   (cli/commands/doc-hooks)
//   setSearchIndexer                    memory and decision writes (cli/commands/memory-support)
//   taskLifecycleSeams.indexTask/removeTask   (cli/commands/task-lifecycle)
//
// docHooks.hardDelete and taskLifecycleSeams.purgeReconciler belong to the reconciler wiring.

import { docHooks } from "../cli/commands/doc-hooks.ts";
import { setSearchIndexer } from "../cli/commands/memory-support.ts";
import { taskLifecycleSeams } from "../cli/commands/task-lifecycle.ts";
import { buildSearchEnvironment, searchRuntimeHooks } from "../domain/searchenv/index.ts";
import {
  bestEffortIndexDecision,
  bestEffortIndexDoc,
  bestEffortIndexMemory,
  bestEffortIndexTask,
  bestEffortRemoveDocID,
  bestEffortRemoveMemory,
  bestEffortRemoveTask,
  bestEffortRenameDoc,
  configureBestEffort,
} from "../runtime/index/best-effort.ts";
import { runSqliteIndexAction } from "../runtime/index/entity.ts";
import { enqueueReindex, goLogf } from "../runtime/queue.ts";
import type { SearchEnvironment } from "../search/config.ts";
import { SemanticNotConfiguredError } from "../search/errors.ts";
import type { Storage } from "../storage/adapters.ts";

let installed = false;

function envMs(key: string, defaultMs: number): number {
  const raw = process.env[key];
  if (raw !== undefined && raw !== "" && /^[+-]?\d+$/.test(raw)) return Math.max(0, Number(raw));
  return defaultMs;
}

const pending = new Map<string, ReturnType<typeof setTimeout>>();
let chain: Promise<void> = Promise.resolve();

/**
 * scheduleBestEffort: Go's in-process indexer (used when the runtime daemon is bypassed). A
 * debounced timer per (store, action, target), serialized, that a short-lived CLI never outlives;
 * long-lived processes (MCP, server) get their index written. Failures are logged, never thrown.
 */
function scheduleBestEffort(
  storage: Storage,
  action: string,
  target: string,
  env: SearchEnvironment,
): void {
  const key = `${storage.store.root}\u0000${action}\u0000${target}`;
  const existing = pending.get(key);
  if (existing) clearTimeout(existing);
  const debounce = action.startsWith("remove-")
    ? 0
    : envMs("KNOWNS_ENTITY_INDEX_DEBOUNCE_MS", 5000);
  const timer = setTimeout(() => {
    pending.delete(key);
    chain = chain.then(async () => {
      try {
        await runSqliteIndexAction(storage, action, target, env);
      } catch (err) {
        if (!(err instanceof SemanticNotConfiguredError)) {
          goLogf(`[search] could not ${action} ${target}: ${(err as Error).message}`);
        }
      }
      const delay = envMs("KNOWNS_INDEX_QUEUE_DELAY_MS", 500);
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    });
  }, debounce);
  timer.unref();
  pending.set(key, timer);
}

export function installRuntime(): void {
  if (installed) return;
  installed = true;
  let env: SearchEnvironment | undefined;
  const getEnv = () => (env ??= buildSearchEnvironment());
  configureBestEffort({
    env: getEnv,
    fallback: (storage, action, target) => scheduleBestEffort(storage, action, target, getEnv()),
  });

  searchRuntimeHooks.enqueueReindex = (storeRoot) => {
    enqueueReindex(storeRoot);
  };

  docHooks.indexDoc = (storage, docPath) => bestEffortIndexDoc(storage, docPath);
  docHooks.removeDocID = (storage, docId, docPath) =>
    bestEffortRemoveDocID(storage, docId, docPath);
  docHooks.renameDoc = (storage, docId, oldPath, newPath) =>
    bestEffortRenameDoc(storage, docId, oldPath, newPath);

  setSearchIndexer({
    indexMemory: (storage, id) => bestEffortIndexMemory(storage, id),
    removeMemory: (storage, id) => bestEffortRemoveMemory(storage, id),
    indexDecision: (storage, id) => bestEffortIndexDecision(storage, id),
  });

  taskLifecycleSeams.indexTask = (storage, id) => bestEffortIndexTask(storage, id);
  taskLifecycleSeams.removeTask = (storage, id) => bestEffortRemoveTask(storage, id);
}
