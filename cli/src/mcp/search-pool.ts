// Runs search calls on worker threads so the daemon's event loop stays free (spec D4, FR-7).
// ToolPool already limits how many heavy calls run at once to the pool width, so a job always finds
// a worker. A worker whose call is cancelled (deadline, session end) is terminated: synchronous
// work cannot be interrupted any other way.
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { CallToolRequest } from "./tool.ts";

export interface SearchJob {
  id: number;
  storeRoot: string;
  projectRoot: string;
  req: CallToolRequest;
}
export interface SearchReply {
  id: number;
  text: string;
  isError: boolean;
}

interface Slot {
  worker: Worker;
  busy: boolean;
}

/**
 * In a compiled binary the bundle is one file and the worker sits next to it as mcp/search-worker.js
 * (scripts/build.ts lists it as an entrypoint); from source it is the TypeScript file.
 */
function spawnSearchWorker(): Worker {
  const compiled = /\$bunfs|~BUN/i.test(decodeURIComponent(import.meta.url));
  const url = compiled
    ? new URL("./mcp/search-worker.js", import.meta.url)
    : new URL("./search-worker.ts", import.meta.url);
  // The embedded file system of a Windows binary is looked up with forward slashes only.
  const target =
    compiled && process.platform === "win32" ? fileURLToPath(url).replaceAll("\\", "/") : url;
  return new Worker(target, { workerData: { env: { ...process.env } } });
}

export class SearchPool {
  private readonly slots: Slot[] = [];
  private nextId = 1;
  private stopped = false;

  constructor(
    private readonly width: number,
    private readonly spawn: () => Worker = spawnSearchWorker,
  ) {}

  get isStopped(): boolean {
    return this.stopped;
  }

  get size(): number {
    return this.slots.length;
  }

  run(
    job: Omit<SearchJob, "id">,
    signal?: AbortSignal,
  ): Promise<{ text: string; isError: boolean }> {
    if (this.stopped) return Promise.reject(new Error("search pool stopped"));
    if (signal?.aborted) return Promise.reject(new Error("search cancelled"));
    const slot = this.take();
    if (!slot) return Promise.reject(new Error("no free search worker"));
    slot.busy = true;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const done = (): void => {
        signal?.removeEventListener("abort", onAbort);
        slot.worker.off("message", onMessage);
        slot.worker.off("error", onError);
        slot.worker.off("exit", onExit);
      };
      const onMessage = (m: SearchReply): void => {
        if (m.id !== id) return;
        done();
        slot.busy = false;
        resolve({ text: m.text, isError: m.isError });
      };
      const fail = (err: Error): void => {
        done();
        this.drop(slot);
        reject(err);
      };
      const onError = (e: Error): void => fail(e);
      const onExit = (): void => fail(new Error("search worker exited"));
      const onAbort = (): void => {
        done();
        this.drop(slot); // a runaway synchronous search is only stopped by ending its thread
        reject(new Error("search cancelled"));
      };
      slot.worker.on("message", onMessage);
      slot.worker.on("error", onError);
      slot.worker.on("exit", onExit);
      signal?.addEventListener("abort", onAbort, { once: true });
      slot.worker.postMessage({ ...job, id });
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all(this.slots.splice(0).map((s) => s.worker.terminate()));
  }

  private take(): Slot | undefined {
    const idle = this.slots.find((s) => !s.busy);
    if (idle) return idle;
    if (this.slots.length >= this.width) return undefined;
    const slot: Slot = { worker: this.spawn(), busy: false };
    slot.worker.unref();
    this.slots.push(slot);
    return slot;
  }

  private drop(slot: Slot): void {
    const i = this.slots.indexOf(slot);
    if (i >= 0) this.slots.splice(i, 1);
    void slot.worker.terminate();
  }
}
