// The reindex flows of internal/cli/search.go: `search --reindex` (also `sync`'s step 6),
// `search index` and `search index --wait`, over the runtime queue and the semantic index writers.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildSearchEnvironment } from "../../domain/searchenv/index.ts";
import {
  SEMANTIC_VECTOR_BACKEND_QDRANT,
  SEMANTIC_VECTOR_STORE_MODE_MANAGED,
  semanticSearchSettingsSchema,
} from "../../models/config.ts";
import { executeRuntimeJob } from "../../runtime/executor.ts";
import { IndexService } from "../../runtime/index/index-service.ts";
import { autoReindexIfStale, initSemanticSqlite } from "../../runtime/index/init-semantic.ts";
import { configFromResolution, installQdrant, QdrantManager } from "../../runtime/qdrant.ts";
import { resolveVectorStoreForEnv } from "../../runtime/qdrant-endpoint.ts";
import {
  acquireClient,
  enqueueReindex,
  type Job,
  type JobWaitOutcome,
  loadJobSnapshot,
  shouldBypassDaemon,
  sleep,
  startHeartbeat,
  waitForJobProgress,
} from "../../runtime/queue.ts";
import { SemanticNotConfiguredError } from "../../search/errors.ts";
import { SQLiteVectorStore } from "../../search/sqlite-store.ts";
import { createStorage, type Storage } from "../../storage/adapters.ts";
import { globalSemanticStoreRoot, Store } from "../../storage/core/store.ts";
import { SilentExit } from "../core/exit.ts";
import { renderCmd, renderInfo, renderWarning } from "../core/plainoutput.ts";
import { renderNextSteps, searchDim, searchSuccess, searchWarn } from "./search-support.ts";

export interface Out {
  print(text: string): void;
}

/**
 * The reindex wait gave up while the daemon still holds the job. The warning is already printed,
 * so the run loop only sets the exit status (1, as 0.34.1), and `sync` skips its "reindex failed".
 */
export class ReindexStillRunning extends SilentExit {
  constructor(readonly jobId: string) {
    super(1);
    this.name = "ReindexStillRunning";
  }
}

/**
 * The reindex wait found no runtime daemon while the job was still queued. The explanation is
 * already printed; exit 1, and `sync` skips its "reindex failed" (the job is kept, not failed).
 */
export class ReindexRuntimeStopped extends SilentExit {
  constructor(readonly jobId: string) {
    super(1);
    this.name = "ReindexRuntimeStopped";
  }
}

const DEFAULT_REINDEX_STALL_MS = 5 * 60_000;

/** How long the reindex wait tolerates a job that does not move (0.34.1's fixed cap, 5 minutes). */
function reindexStallMs(envVars: Record<string, string | undefined>): number {
  const raw = envVars.KNOWNS_RUNTIME_REINDEX_STALL_MS?.trim();
  if (raw && /^\d+$/.test(raw) && Number(raw) > 0) return Number(raw);
  return DEFAULT_REINDEX_STALL_MS;
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
      // A phase line is printed as soon as the next phase begins, so a long reindex shows where it
      // is; a completed run prints the same lines as before, only earlier.
      const printPhase = (name: string, total: number): void =>
        out.print(`  ${searchSuccess("✓")} Indexed ${name} (${total})\n`);
      let lastPhase = "";
      let lastTotal = 0;
      const done = waitForJobProgress(storeRoot, job.id, reindexStallMs(envVars)).then(
        (outcome) => ({ outcome }),
        (error: Error) => ({ error }),
      );
      const state: { done: boolean; outcome?: JobWaitOutcome; error?: Error } = { done: false };
      void done.then((r) => {
        state.done = true;
        Object.assign(state, r);
      });
      while (!state.done) {
        try {
          const snap = loadJobSnapshot(storeRoot, job.id);
          if (snap.found && !snap.completed) {
            const phase = snap.job?.phase || "queued";
            if (phase !== lastPhase && lastPhase !== "") printPhase(lastPhase, lastTotal);
            lastPhase = phase;
            lastTotal = (snap.job?.total ?? 0) > 0 ? (snap.job?.total as number) : 1;
          }
        } catch {
          // keep polling
        }
        await sleep(200);
      }
      if (state.outcome && state.outcome.status !== "completed") {
        // The job is still in the queue, so it has not failed. Reporting "reindex failed" here made
        // users rerun a reindex that was about to succeed (@task-KN-Q6DVKQ); the exit status
        // stays 1 as in 0.34.1, because the index is not rebuilt yet.
        const pending = state.outcome.job;
        const where = pending.startedAt
          ? `${pending.phase || "running"}${(pending.total ?? 0) > 0 ? ` ${pending.processed ?? 0}/${pending.total}` : ""}`
          : "queued";
        if (state.outcome.status === "stopped") {
          // No daemon is left to run it: "still running" would be false. Any command that queues
          // work starts the runtime, and a new reindex request reuses the queued job.
          out.print(
            `\n${renderWarning(`The runtime stopped before the reindex finished (job ${pending.id}, ${where}). The job stays queued and runs when the runtime starts again.`)}\n`,
          );
          out.print(
            `${searchDim("Start it with:")} ${renderCmd("knowns search --reindex")} ${searchDim("(reuses the queued job)")}\n`,
          );
          throw new ReindexRuntimeStopped(pending.id);
        }
        out.print(
          `\n${renderWarning(`Reindex is still running in the runtime (job ${pending.id}, ${where}). It was not rebuilt yet; do not start another one.`)}\n`,
        );
        out.print(`${searchDim("Follow it with:")} ${renderCmd("knowns runtime ps")}\n`);
        throw new ReindexStillRunning(pending.id);
      }
      if (lastPhase !== "") printPhase(lastPhase, lastTotal);
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
  const res = resolveVectorStoreForEnv(project, global, envVars);
  if (!res.enabled || res.optedOut) {
    throw new Error("semantic vector search is disabled; enable it before indexing");
  }
  if (
    res.backend === SEMANTIC_VECTOR_BACKEND_QDRANT &&
    res.mode === SEMANTIC_VECTOR_STORE_MODE_MANAGED
  ) {
    const mgr = new QdrantManager(configFromResolution(res));
    try {
      await installQdrant(mgr.paths().root);
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
