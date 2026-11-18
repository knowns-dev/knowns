// Daemon-wide limits for MCP tool calls (spec D4, FR-7, @task-KN-SR962X).
//
// Light tools (task, doc, time, ...) run straight on the daemon's event loop. Heavy tools (search,
// code) pass through one shared gate whose width follows the CPU count (1..4), so a slow code
// operation in one session cannot occupy every slot or starve the light calls of other sessions.
// Every call also has a deadline: when it passes, the owning session gets an error and the call's
// signal is aborted; nothing else is affected. A slot is held until the handler really settles, so
// the bound is true even for a handler that ignores its signal.
import { availableParallelism } from "node:os";

/** Tools that do real work in the background: search indexes, language servers. */
export const HEAVY_TOOLS: ReadonlySet<string> = new Set(["search", "code"]);

export const DEFAULT_CALL_TIMEOUT_MS = 120_000;

/** 1..4 from the CPU count: half the cores, at least one, at most four. */
export function defaultPoolWidth(cpus: number = availableParallelism()): number {
  return Math.min(4, Math.max(1, Math.floor(cpus / 2)));
}

export class CallTimeoutError extends Error {
  constructor(
    readonly tool: string,
    readonly ms: number,
  ) {
    super(
      HEAVY_TOOLS.has(tool)
        ? `${tool} timed out after ${ms} ms`
        : // A light tool may be a write: its handler keeps running after the deadline.
          `${tool} did not answer within ${ms} ms; the operation may still complete, so check the result before retrying`,
    );
  }
}

/** How long after the deadline a heavy handler that ignores its signal keeps its slot. */
export const DEFAULT_SLOT_GRACE_MS = 30_000;
/** Leaked slots after which the pool asks for a restart of what is hanging (the language servers). */
export const LEAK_CAP = 2;

export class ToolPool {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  private leaked = 0;

  constructor(
    readonly width: number = defaultPoolWidth(),
    readonly timeoutMs: number = DEFAULT_CALL_TIMEOUT_MS,
    readonly slotGraceMs: number = DEFAULT_SLOT_GRACE_MS,
    /** Called once the number of leaked slots reaches LEAK_CAP (it may restart the hung part). */
    readonly onLeakCap?: () => void,
  ) {}

  /** Slots given up on because their handler never settled. */
  get leakedSlots(): number {
    return this.leaked;
  }

  get running(): number {
    return this.active;
  }
  get queued(): number {
    return this.waiting.length;
  }

  /**
   * Runs `fn` under the deadline. A heavy tool first waits for a free slot (the wait counts toward
   * the deadline, and an aborted session leaves the queue). `fn` receives a signal that fires on
   * the deadline or when `outer` aborts.
   */
  async run<T>(
    tool: string,
    fn: (signal: AbortSignal) => Promise<T>,
    outer?: AbortSignal,
  ): Promise<T> {
    const ac = new AbortController();
    const onOuter = (): void => ac.abort();
    if (outer?.aborted) ac.abort();
    else outer?.addEventListener("abort", onOuter, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let held = false;
    let gaveUp = false;
    const heavy = HEAVY_TOOLS.has(tool);
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new CallTimeoutError(tool, this.timeoutMs));
        ac.abort();
        // A handler that ignores its signal (a stuck language server) would hold its slot for
        // ever and starve every session on a small machine: after a grace the slot is given up.
        if (heavy && held) {
          graceTimer = setTimeout(() => {
            if (!held) return;
            held = false;
            gaveUp = true;
            this.leaked++;
            this.release();
            if (this.leaked === LEAK_CAP) this.onLeakCap?.();
          }, this.slotGraceMs);
          graceTimer.unref?.();
        }
      }, this.timeoutMs);
    });
    deadline.catch(() => undefined);
    const work = (async (): Promise<T> => {
      if (heavy) {
        await this.acquire(ac.signal);
        held = true;
      }
      try {
        return await fn(ac.signal);
      } finally {
        if (graceTimer) clearTimeout(graceTimer);
        if (held) {
          held = false;
          this.release();
        } else if (gaveUp) {
          // The handler finally settled after its slot was given up: the leak is repaid.
          gaveUp = false;
          this.leaked = Math.max(0, this.leaked - 1);
        }
      }
    })();
    work.catch(() => undefined); // a late failure after the deadline is not unhandled
    try {
      return await Promise.race([work, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
      outer?.removeEventListener("abort", onOuter);
    }
  }

  private acquire(signal: AbortSignal): Promise<void> {
    if (this.active < this.width) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const grant = (): void => {
        signal.removeEventListener("abort", leave);
        this.active++;
        resolve();
      };
      const leave = (): void => {
        const i = this.waiting.indexOf(grant);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(new Error("call cancelled while waiting for a free slot"));
      };
      this.waiting.push(grant);
      signal.addEventListener("abort", leave, { once: true });
    });
  }

  private release(): void {
    this.active--;
    this.waiting.shift()?.();
  }
}

let shared: ToolPool | undefined;

/** The one pool of this process (the daemon), shared by all its sessions. */
export function sharedToolPool(): ToolPool {
  if (!shared) {
    const ms = Number(process.env.KNOWNS_MCP_CALL_TIMEOUT_MS);
    shared = new ToolPool(
      undefined,
      Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_CALL_TIMEOUT_MS,
      DEFAULT_SLOT_GRACE_MS,
      () => {
        // Hung heavy handlers have used up their slots: stop every language server so the
        // requests they wait on fail and the next call starts fresh ones.
        process.stderr.write("[mcp] heavy-call slots leaked; restarting language servers\n");
        void import("./state.ts").then((m) => m.restartAllLanguageServers()).catch(() => {});
      },
    );
  }
  return shared;
}

let searchPool: import("./search-pool.ts").SearchPool | undefined;

/** The worker threads behind the search tool, sized like the heavy gate. */
export async function sharedSearchPool(): Promise<import("./search-pool.ts").SearchPool> {
  if (!searchPool || searchPool.isStopped) {
    const { SearchPool } = await import("./search-pool.ts");
    searchPool = new SearchPool(sharedToolPool().width);
  }
  return searchPool;
}

/** Stops the search workers, if any were started (daemon and host shutdown, end of a test run). */
export async function stopSharedSearchPool(): Promise<void> {
  const pool = searchPool;
  searchPool = undefined;
  await pool?.stop();
}
