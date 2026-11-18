// Starting worker threads from source and from a compiled binary.
//
// From source a worker is its TypeScript file next to the caller. A `bun build --compile` binary
// embeds a worker only when the build lists it as an entrypoint (scripts/build.ts), and then it
// sits beside the bundle as <dir>/<name>.js, so the path is given relative to the bundle root.
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

// Worker threads this module started and that have not exited. Bun 1.3.12 on Windows panics when
// the process ends while worker threads are still alive ("Internal assertion failure", header
// workers_spawned(n) workers_terminated(m) with m < n), so whoever owns a worker must stop it, and
// this registry lets a test or a shutdown path see what is left.
/** KNOWNS_WORKER_LOG=<file> appends one line per worker start and exit (memory investigations). */
function traceWorker(line: string): void {
  const file = process.env.KNOWNS_WORKER_LOG;
  if (!file) return;
  try {
    appendFileSync(file, `${new Date().toISOString()} pid=${process.pid} ${line}\n`);
  } catch {
    // diagnostics only
  }
}

const live = new Map<Worker, string>();

/** Bundled workers that have not exited, with the stack that started each. */
export function liveBundledWorkers(): Array<{ worker: Worker; startedAt: string }> {
  return [...live].map(([worker, startedAt]) => ({ worker, startedAt }));
}

/** Terminates every bundled worker still alive (a last resort at the end of a process). */
export async function terminateBundledWorkers(): Promise<void> {
  await Promise.all([...live.keys()].map((w) => w.terminate().catch(() => undefined)));
}

/**
 * @param sourceUrl      `new URL("./x-worker.ts", import.meta.url)` of the caller
 * @param bundledPath    the worker inside a compiled binary, e.g. "runtime/x-worker.js"
 * @param workerData     extra data; the parent's environment is always sent as `workerData.env`
 */
export function spawnBundledWorker(
  sourceUrl: URL,
  bundledPath: string,
  workerData: Record<string, unknown> = {},
): Worker {
  const compiled = /\$bunfs|~BUN/i.test(decodeURIComponent(import.meta.url));
  const url = compiled ? new URL(`./${bundledPath}`, import.meta.url) : sourceUrl;
  // The embedded file system of a Windows binary is looked up with forward slashes only.
  const target =
    compiled && process.platform === "win32" ? fileURLToPath(url).replaceAll("\\", "/") : url;
  const worker = new Worker(target, { workerData: { ...workerData, env: { ...process.env } } });
  live.set(worker, new Error("worker started here").stack ?? "");
  traceWorker(`start ${bundledPath} live=${live.size}`);
  worker.once("exit", () => {
    live.delete(worker);
    traceWorker(`exit ${bundledPath} live=${live.size}`);
  });
  return worker;
}

/** Bun starts a worker with the environment the process began with, not the parent's current one,
 * and ignores assignment to HOME inside a worker (1.3.12): the parent sends its own env and the
 * worker applies it, so only variables set after the process started are carried over. */
export function applyParentEnv(
  data: { env?: Record<string, string | undefined> } | undefined,
): void {
  if (data?.env) Object.assign(process.env, data.env);
}
