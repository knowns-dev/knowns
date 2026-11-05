// The reindex flows of internal/cli/search.go: `search --reindex` (also `sync`'s step 6),
// `search index` and `search index --wait`, over the runtime queue and the semantic index writers.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildSearchEnvironment } from "../../domain/searchenv/index.ts";
import {
  resolveSemanticVectorStore,
  SEMANTIC_VECTOR_BACKEND_QDRANT,
  SEMANTIC_VECTOR_STORE_MODE_MANAGED,
  semanticSearchSettingsSchema,
} from "../../models/config.ts";
import { executeRuntimeJob } from "../../runtime/executor.ts";
import { IndexService } from "../../runtime/index/index-service.ts";
import { autoReindexIfStale, initSemanticSqlite } from "../../runtime/index/init-semantic.ts";
import { configFromResolution, installQdrant, QdrantManager } from "../../runtime/qdrant.ts";
import {
  acquireClient,
  enqueueReindex,
  type Job,
  loadJobSnapshot,
  shouldBypassDaemon,
  sleep,
  startHeartbeat,
  waitForJob,
} from "../../runtime/queue.ts";
import { SemanticNotConfiguredError } from "../../search/errors.ts";
import { SQLiteVectorStore } from "../../search/sqlite-store.ts";
import { createStorage, type Storage } from "../../storage/adapters.ts";
import { globalSemanticStoreRoot, Store } from "../../storage/core/store.ts";
import { renderCmd, renderInfo, renderWarning } from "../core/plainoutput.ts";
import { renderNextSteps, searchDim, searchSuccess, searchWarn } from "./search-support.ts";

export interface Out {
  print(text: string): void;
}

function count(fn: () => unknown[]): number {
  try {
    return fn().length;
  } catch {
    return 0;
  }
}

/** reindexSemanticStore: rebuild one store's legacy index and print its chunk count. */
async function reindexSemanticStore(
  out: Out,
  storage: Storage,
  env: ReturnType<typeof buildSearchEnvironment>,
  label: string,
): Promise<void> {
  // Opening the config can fail (a missing global store config); that is reported by the caller.
  storage.config.load();
  const sem = initSemanticSqlite(storage, env);
  try {
    await autoReindexIfStale(storage, sem);
    await new IndexService(storage, sem.embedder, sem.store).reindex();
    out.print(
      `${searchSuccess(`✓ ${label} semantic index rebuilt (${sem.store.count()} chunks)`)}\n`,
    );
  } finally {
    sem.embedder.close();
    sem.store.close();
  }
}

/** reindexSemanticStores: project, then the machine-level store. */
async function reindexSemanticStores(
  out: Out,
  storage: Storage,
  env: ReturnType<typeof buildSearchEnvironment>,
): Promise<void> {
  try {
    await reindexSemanticStore(out, storage, env, "Project");
  } catch (err) {
    if (!(err instanceof SemanticNotConfiguredError)) throw err;
  }
  const globalConfig = join(globalSemanticStoreRoot(), "config.json");
  if (!existsSync(globalConfig)) {
    // Go wraps the open error twice; Windows words a missing parent and a missing file differently.
    const reason =
      process.platform !== "win32"
        ? "no such file or directory"
        : existsSync(dirname(globalConfig))
          ? "The system cannot find the file specified."
          : "The system cannot find the path specified.";
    throw new Error(`load config: load config: open ${globalConfig}: ${reason}`);
  }
  const global = createStorage(Store.openGlobalSemantic());
  try {
    await reindexSemanticStore(out, global, env, "Global");
  } catch (err) {
    if (!(err instanceof SemanticNotConfiguredError)) throw err;
  }
}

/** runReindex. */
export async function runReindex(
  out: Out,
  storage: Storage,
  envVars: Record<string, string | undefined>,
): Promise<void> {
  const tasks = count(() => storage.tasks.listAll());
  const docs = count(() => storage.docs.list());
  const decisions = count(() => storage.decisions.list());
  if (tasks + docs + decisions === 0) {
    out.print(`${renderWarning("No tasks, docs, or decisions to index.")}\n`);
    return;
  }
  const storeRoot = storage.store.root;
  if (!shouldBypassDaemon(envVars)) {
    let handle: ReturnType<typeof acquireClient>;
    try {
      handle = acquireClient("cli-reindex", storeRoot, false);
    } catch (err) {
      throw new Error(`start runtime reindex: ${(err as Error).message}`);
    }
    const ac = new AbortController();
    try {
      startHeartbeat(ac.signal, handle);
      let job: Job;
      try {
        job = enqueueReindex(storeRoot);
      } catch (err) {
        throw new Error(`enqueue reindex: ${(err as Error).message}`);
      }
      out.print(
        `${renderInfo(`Queued runtime reindex (${tasks} tasks, ${docs} docs, ${decisions} decisions)...`)}\n\n`,
      );
      const phases: { name: string; count: number }[] = [];
      let lastPhase = "";
      let lastTotal = 0;
      const done = waitForJob(storeRoot, job.id, 5 * 60_000).then(
        () => undefined,
        (e: Error) => e,
      );
      const state: { done: boolean; error?: Error } = { done: false };
      void done.then((e) => {
        state.done = true;
        if (e) state.error = e;
      });
      while (!state.done) {
        try {
          const snap = loadJobSnapshot(storeRoot, job.id);
          if (snap.found && !snap.completed) {
            const phase = snap.job?.phase || "queued";
            if (phase !== lastPhase && lastPhase !== "")
              phases.push({ name: lastPhase, count: lastTotal });
            lastPhase = phase;
            lastTotal = (snap.job?.total ?? 0) > 0 ? (snap.job?.total as number) : 1;
          }
        } catch {
          // keep polling
        }
        await sleep(200);
      }
      if (lastPhase !== "") phases.push({ name: lastPhase, count: lastTotal });
      for (const p of phases) out.print(`  ${searchSuccess("✓")} Indexed ${p.name} (${p.count})\n`);
      if (state.error) throw new Error(`reindex failed: ${state.error.message}`);
      const stats = new SQLiteVectorStore(join(storeRoot, ".search"), "", 0).stats();
      out.print(
        `${searchSuccess(`✓ Search index rebuilt via runtime (${tasks} tasks, ${docs} docs, ${decisions} decisions, ${stats.chunkCount} chunks)`)}\n`,
      );
      return;
    } finally {
      ac.abort();
    }
  }

  const env = buildSearchEnvironment({ env: envVars });
  let failure: Error | undefined;
  try {
    await reindexSemanticStores(out, storage, env);
    return;
  } catch (err) {
    failure = err as Error;
  }
  if (!(failure instanceof SemanticNotConfiguredError)) {
    out.print(`${searchWarn(`Semantic search initialization failed: ${failure.message}`)}\n\n`);
  }
  out.print(`${searchDim("Semantic search is not configured.")}\n\n`);
  out.print(
    `${renderNextSteps(renderCmd("knowns settings"), renderCmd("knowns search --reindex"))}\n`,
  );
  out.print(
    `${searchDim("Keyword search does not require indexing (scans tasks/docs on each query).")}\n`,
  );
  out.print(
    `${renderInfo(`Found ${tasks} tasks, ${docs} docs, and ${decisions} decisions available for keyword search.`)}\n`,
  );
}

/** newSearchIndexCmd's RunE. */
export async function runSearchIndex(
  out: Out,
  storage: Storage,
  wait: boolean,
  envVars: Record<string, string | undefined>,
): Promise<void> {
  const root = storage.store.root;
  if (!wait) {
    const job = enqueueReindex(root);
    out.print(`queued semantic reindex ${job.id}\n`);
    return;
  }
  const searchEnv = buildSearchEnvironment({ env: envVars });
  let project: ReturnType<Storage["config"]["load"]>["settings"]["semanticSearch"];
  try {
    project = storage.config.load().settings.semanticSearch;
  } catch {
    project = undefined;
  }
  let global: typeof project;
  try {
    const raw = searchEnv.embeddingRegistry().projectDefaults?.settings.semanticSearch;
    const parsed = semanticSearchSettingsSchema.safeParse(raw);
    if (parsed.success) global = parsed.data;
  } catch {
    global = undefined;
  }
  // Go passes a nil lookup, which means the process environment.
  const res = resolveSemanticVectorStore(project, global, (k) => envVars[k]);
  if (!res.enabled || res.optedOut) {
    throw new Error("semantic vector search is disabled; enable it before indexing");
  }
  if (
    res.backend === SEMANTIC_VECTOR_BACKEND_QDRANT &&
    res.mode === SEMANTIC_VECTOR_STORE_MODE_MANAGED
  ) {
    const mgr = new QdrantManager(configFromResolution(res));
    try {
      installQdrant(mgr.paths().root);
    } catch (err) {
      throw new Error(`install managed Qdrant: ${(err as Error).message}`);
    }
    try {
      await mgr.start();
    } catch (err) {
      throw new Error(
        `start managed Qdrant: ${(err as Error).message} (inspect: knowns qdrant logs)`,
      );
    }
  }
  const now = new Date().toISOString();
  const job: Job = {
    id: "blocking-index",
    key: "",
    kind: "reindex-search",
    requestedAt: now,
    runAfter: now,
  };
  try {
    await executeRuntimeJob(root, job);
  } catch (err) {
    throw new Error(`blocking semantic index failed: ${(err as Error).message}`);
  }
  out.print("semantic index completed\n");
}
