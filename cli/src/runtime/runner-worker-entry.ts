// The thread side of runner-worker.ts: executes queue jobs and runs knowledge watchers.
import { parentPort, workerData } from "node:worker_threads";
import { applyParentEnv } from "../util/worker.ts";
import type { RunnerReply, RunnerRequest } from "./runner-worker.ts";

applyParentEnv(workerData);

const watchers = new Map<number, AbortController>();
const reply = (r: RunnerReply): void => parentPort?.postMessage(r);
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

parentPort?.on("message", async (req: RunnerRequest) => {
  if (req.t === "unwatch") {
    watchers.get(req.id)?.abort();
    return;
  }
  if (req.t === "job") {
    try {
      const { executeRuntimeJobCore } = await import("./executor.ts");
      await executeRuntimeJobCore(req.storeRoot, req.job);
      reply({ t: "done", id: req.id });
    } catch (e) {
      reply({ t: "done", id: req.id, error: message(e) });
    }
    return;
  }
  const ac = new AbortController();
  watchers.set(req.id, ac);
  try {
    const { startRuntimeWatcher } = await import("../domain/reconcile/watcher.ts");
    const { runtimeIndexEnqueuer } = await import("./executor.ts");
    await startRuntimeWatcher(req.storeRoot, {
      signal: ac.signal,
      index: runtimeIndexEnqueuer(req.storeRoot),
      onError: (err) => process.stderr.write(`[runtime] watcher: ${message(err)}\n`),
    });
    reply({ t: "ended", id: req.id });
  } catch (e) {
    reply({ t: "ended", id: req.id, error: message(e) });
  } finally {
    watchers.delete(req.id);
  }
});
