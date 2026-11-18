// Runs search calls on worker threads so the daemon's event loop stays free (spec D4, FR-7).
// ToolPool already limits how many heavy calls run at once to the pool width. A worker thread keeps
// a whole copy of the module graph (~45 MB of working set on Windows), so the pool starts none until
// the first search, keeps one for ordinary use, adds another only while a call has waited for a free
// worker longer than GROW_AFTER_MS (up to the width), and ends a worker that has been idle for
// IDLE_MS. A worker whose call is cancelled (deadline, session end) is terminated: synchronous work
// cannot be interrupted any other way.
import type { Worker } from "node:worker_threads";
import { spawnBundledWorker } from "../util/worker.ts";
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
  idleTimer?: ReturnType<typeof setTimeout>;
}

interface Waiter {
  grant: (slot: Slot) => void;
  fail: (e: Error) => void;
  growTimer?: ReturnType<typeof setTimeout>;
}

export const SEARCH_IDLE_MS = 60_000;
export const SEARCH_GROW_AFTER_MS = 200;

export interface SearchPoolOptions {
  /** An idle worker is ended after this long (0 keeps it for ever). */
  idleMs?: number;
  /** A call that has waited this long for a free worker makes the pool start another. */
  growAfterMs?: number;
}

function spawnSearchWorker(): Worker {
  return spawnBundledWorker(new URL("./search-worker.ts", import.meta.url), "mcp/search-worker.js");
}

export class SearchPool {
  private readonly slots: Slot[] = [];
  private readonly waiters: Waiter[] = [];
  private nextId = 1;
  private stopped = false;
  private readonly idleMs: number;
  private readonly growAfterMs: number;

  constructor(
    private readonly width: number,
    private readonly spawn: () => Worker = spawnSearchWorker,
    opts: SearchPoolOptions = {},
  ) {
    this.idleMs = opts.idleMs ?? (Number(process.env.KNOWNS_SEARCH_IDLE_MS) || SEARCH_IDLE_MS);
    this.growAfterMs = opts.growAfterMs ?? SEARCH_GROW_AFTER_MS;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  get size(): number {
    return this.slots.length;
  }

  async run(
    job: Omit<SearchJob, "id">,
    signal?: AbortSignal,
  ): Promise<{ text: string; isError: boolean }> {
    if (this.stopped) throw new Error("search pool stopped");
    if (signal?.aborted) throw new Error("search cancelled");
    const busy = this.slots.filter((s) => s.busy).length;
    if (busy + this.waiters.length >= this.width) throw new Error("no free search worker");
    const slot = await this.acquire(signal);
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
        this.release(slot);
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
    for (const w of this.waiters.splice(0)) {
      if (w.growTimer) clearTimeout(w.growTimer);
      w.fail(new Error("search pool stopped"));
    }
    const slots = this.slots.splice(0);
    for (const s of slots) if (s.idleTimer) clearTimeout(s.idleTimer);
    await Promise.all(slots.map((s) => s.worker.terminate()));
  }

  /** A free worker; the first one is started at once, more only after a wait (see the header). */
  private acquire(signal?: AbortSignal): Promise<Slot> {
    const idle = this.slots.find((s) => !s.busy);
    if (idle) return Promise.resolve(this.claim(idle));
    if (this.slots.length === 0) return Promise.resolve(this.claim(this.add()));
    return new Promise<Slot>((resolve, reject) => {
      const waiter: Waiter = { grant: (slot) => resolve(slot), fail: reject };
      const leave = (): void => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        if (waiter.growTimer) clearTimeout(waiter.growTimer);
        reject(new Error("search cancelled"));
      };
      const grant = waiter.grant;
      waiter.grant = (slot) => {
        signal?.removeEventListener("abort", leave);
        if (waiter.growTimer) clearTimeout(waiter.growTimer);
        grant(slot);
      };
      signal?.addEventListener("abort", leave, { once: true });
      waiter.growTimer = setTimeout(() => {
        waiter.growTimer = undefined;
        if (this.stopped || !this.waiters.includes(waiter)) return;
        if (this.slots.length >= this.width) return;
        const i = this.waiters.indexOf(waiter);
        this.waiters.splice(i, 1);
        waiter.grant(this.claim(this.add()));
      }, this.growAfterMs);
      this.waiters.push(waiter);
    });
  }

  private claim(slot: Slot): Slot {
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
    slot.idleTimer = undefined;
    slot.busy = true;
    return slot;
  }

  private add(): Slot {
    const slot: Slot = { worker: this.spawn(), busy: false };
    slot.worker.unref();
    // Permanent listeners: a worker that crashes or exits while idle must not raise an unhandled
    // 'error' (it would bring the daemon down) nor stay in the pool (the next call would hang).
    slot.worker.on("error", () => this.drop(slot));
    slot.worker.on("exit", () => this.drop(slot));
    this.slots.push(slot);
    return slot;
  }

  /** The call is over: the worker goes to the next waiting call, or starts its idle countdown. */
  private release(slot: Slot): void {
    slot.busy = false;
    const next = this.waiters.shift();
    if (next) {
      next.grant(this.claim(slot));
      return;
    }
    if (this.idleMs <= 0 || this.stopped) return;
    slot.idleTimer = setTimeout(() => {
      slot.idleTimer = undefined;
      if (!slot.busy) this.drop(slot);
    }, this.idleMs);
    slot.idleTimer.unref?.();
  }

  private drop(slot: Slot): void {
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
    slot.idleTimer = undefined;
    const i = this.slots.indexOf(slot);
    if (i >= 0) this.slots.splice(i, 1);
    void slot.worker.terminate();
    // Someone is waiting and no worker is left to free up: start one for them.
    if (!this.stopped && this.slots.length === 0) {
      const next = this.waiters.shift();
      if (next) next.grant(this.claim(this.add()));
    }
  }
}
