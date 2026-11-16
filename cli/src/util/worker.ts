// Starting worker threads from source and from a compiled binary.
//
// From source a worker is its TypeScript file next to the caller. A `bun build --compile` binary
// embeds a worker only when the build lists it as an entrypoint (scripts/build.ts), and then it
// sits beside the bundle as <dir>/<name>.js, so the path is given relative to the bundle root.
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

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
  return new Worker(target, { workerData: { ...workerData, env: { ...process.env } } });
}

/** Bun starts a worker with the environment the process began with, not the parent's current one,
 * and ignores assignment to HOME inside a worker (1.3.12): the parent sends its own env and the
 * worker applies it, so only variables set after the process started are carried over. */
export function applyParentEnv(
  data: { env?: Record<string, string | undefined> } | undefined,
): void {
  if (data?.env) Object.assign(process.env, data.env);
}
