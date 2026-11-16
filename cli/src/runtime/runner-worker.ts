// The runner's heavy work off the daemon's main thread (spec D4, @task-KN-A2VZN1).
//
// The runner (the newest daemon alive, @task-KN-9FGFP0) runs two kinds of synchronous-heavy work:
// reconciling edited knowledge files (parse, hash, history) and executing queue jobs (indexing).
// Left on the main thread they stall every MCP session the daemon hosts. Here each kind gets its
// own worker thread, started on first use, so a standby daemon never starts one and a stuck job
// cannot hold up the watchers. The queue, leases, status files and the role stay on the main thread.
//
// A worker that crashes, or a job that outlives its deadline, ends that worker: the call that was
// in it fails (the queue records the job as failed, as for a thrown executor) and the next call
// starts a fresh worker.
import type { Worker } from "node:worker_threads";
import { spawnBundledWorker } from "../util/worker.ts";
import type { Job } from "./queue.ts";

export type RunnerRequest =
  | { t: "job"; id: number; storeRoot: string; job: Job }
  | { t: "watch"; id: number; storeRoot: string }
  | { t: "unwatch"; id: number };

export type RunnerReply = { t: "done" | "ended"; id: number; error?: string };

const DEFAULT_JOB_TIMEOUT_MS = 30 * 60_000;
/** How long the next request waits for a terminated worker thread to be gone. */
const TERMINATE_WAIT_MS = 2000;

interface Pending {
  resolve: () => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export function runnerWorkersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KNOWNS_RUNNER_WORKER !== "0";
}

export class RunnerWorker {
  private worker: Worker | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private stopped = false;
  private terminating: Promise<unknown> | undefined;

  constructor(
    private readonly spawn: () => Worker = spawnRunnerWorker,
    private readonly jobTimeoutMs: number = Number(process.env.KNOWNS_RUNNER_JOB_TIMEOUT_MS) ||
      DEFAULT_JOB_TIMEOUT_MS,
  ) {}

  get running(): boolean {
    return this.worker !== undefined;
  }

  /** Runs one queue job in the worker. Rejects when the job throws, the worker dies or it times out. */
  runJob(storeRoot: string, job: Job): Promise<void> {
    return this.request((id) => ({ t: "job", id, storeRoot, job }), this.jobTimeoutMs);
  }

  /** Runs a knowledge watcher in the worker until `signal` aborts (the WatcherFactory contract). */
  watch(signal: AbortSignal, storeRoot: string): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    let id = 0;
    const p = this.request(
      (i) => {
        id = i;
        return { t: "watch", id, storeRoot };
      },
      undefined,
      signal,
    );
    signal.addEventListener(
      "abort",
      () => {
        if (id !== 0) this.worker?.postMessage({ t: "unwatch", id });
      },
      { once: true },
    );
    return p;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const w = this.worker;
    this.worker = undefined;
    this.failAll(new Error("runner worker stopped"));
    await w?.terminate();
  }

  /**
   * Always returns a promise: a worker that cannot be started (a missing entry in a compiled
   * build, EMFILE) or written to rejects it instead of throwing into the daemon loop.
   */
  private async request(
    make: (id: number) => RunnerRequest,
    timeoutMs?: number,
    cancel?: AbortSignal,
  ): Promise<void> {
    if (this.stopped) throw new Error("runner worker stopped");
    // The previous thread may still be inside a native call: wait for it to end (bounded).
    if (this.terminating) {
      let cap: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.terminating,
        new Promise<void>((r) => {
          cap = setTimeout(r, TERMINATE_WAIT_MS);
        }),
      ]);
      if (cap) clearTimeout(cap);
      if (this.stopped) throw new Error("runner worker stopped");
    }
    if (cancel?.aborted) return;
    const w = this.ensure();
    const id = this.nextId++;
    return new Promise<void>((resolve, reject) => {
      const entry: Pending = { resolve, reject };
      if (timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          // Synchronous work cannot be interrupted any other way.
          this.recycle(new Error(`runner job timed out after ${timeoutMs} ms`));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      try {
        w.postMessage(make(id));
      } catch (err) {
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = this.spawn();
    w.unref();
    w.on("message", (m: RunnerReply) => {
      const e = this.pending.get(m.id);
      if (!e) return;
      this.pending.delete(m.id);
      if (e.timer) clearTimeout(e.timer);
      if (m.error) e.reject(new Error(m.error));
      else e.resolve();
    });
    w.on("error", (err) => {
      if (this.worker === w) this.recycle(err instanceof Error ? err : new Error(String(err)));
    });
    w.on("exit", () => {
      if (this.worker === w) this.recycle(new Error("runner worker exited"));
    });
    this.worker = w;
    return w;
  }

  /** Ends the current worker and fails what was in it; the next request starts a new one. */
  private recycle(reason: Error): void {
    const w = this.worker;
    this.worker = undefined;
    this.failAll(reason);
    if (!w) return;
    const t = w.terminate().catch(() => undefined);
    this.terminating = t;
    void t.then(() => {
      if (this.terminating === t) this.terminating = undefined;
    });
  }

  private failAll(reason: Error): void {
    for (const [, e] of this.pending) {
      if (e.timer) clearTimeout(e.timer);
      e.reject(reason);
    }
    this.pending.clear();
  }
}

function spawnRunnerWorker(): Worker {
  return spawnBundledWorker(
    new URL("./runner-worker-entry.ts", import.meta.url),
    "runtime/runner-worker-entry.js",
  );
}
