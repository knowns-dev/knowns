// The Activity Tray's operation registry (spec specs/2026-11-17/activity-tray). One per UI listener:
// web-started operations register here, daemon jobs are merged in from the job source, and every
// change reaches open tabs as operation:* SSE events, coalesced per operation. Wire types are in
// runtime/operation-types.ts.
import {
  isTerminalState,
  type JobOperationSource,
  OPERATION_DONE_EXPIRY_MS,
  OPERATION_EVENT_MIN_INTERVAL_MS,
  OPERATION_FAILED_CAP,
  OPERATION_FAILED_MAX_AGE_MS,
  type Operation,
  type OperationEvent,
  type OperationEventName,
  type OperationRemovedEvent,
  type OperationSnapshot,
  type OperationState,
} from "../runtime/operation-types.ts";
import { type DismissStore, memoryDismissals } from "./dismissed-operations.ts";

export interface RegistryDeps {
  /** Sends one SSE event to every open tab. */
  emit: (name: OperationEventName, data: OperationEvent | OperationRemovedEvent) => void;
  /** The daemon job source (loaded lazily); undefined when there is none (foreground server). */
  jobs?: () => Promise<JobOperationSource | undefined>;
  /**
   * Starts whatever tells this process that a queue changed (a directory watch); `poke` makes the
   * job source re-read the queues. Returns the stop function. Used only while an event stream is
   * open and only for a server that does not run the daemon loop itself, which observes on its own.
   */
  watchJobs?: (poke: () => void) => () => void;
  now?: () => number;
  minIntervalMs?: number;
  doneExpiryMs?: number;
  failedCap?: number;
  /** A failed daemon job older than this is not shown. */
  failedMaxAgeMs?: number;
  /** The project the server shows now, reported in the snapshot. */
  currentProjectRoot?: () => string | null;
  /** Where dismissed daemon rows are remembered; memory only when absent. */
  dismissals?: DismissStore;
}

export interface StartSpec {
  kind: string;
  title: string;
  project?: string | null;
  projectRoot?: string | null;
  state?: "queued" | "running";
  progress?: { done: number; total: number } | null;
  /** Whether a cancel request does something safe while running. */
  cancellable?: boolean;
  /** Re-runs the same request; present only for kinds that support it. */
  retry?: () => Operation | Promise<Operation>;
  message?: string | null;
}

/** What the code running a web operation holds. */
export interface OperationHandle {
  readonly id: string;
  progress(done: number, total: number): void;
  /** True once a cancel was requested: the work stops at its next safe point. */
  readonly cancelRequested: boolean;
  setCancellable(v: boolean): void;
  finish(message?: string | null): void;
  fail(error: string, message?: string | null): void;
  cancelled(message?: string | null): void;
}

interface Entry {
  op: Operation;
  web: boolean;
  cancelRequested: boolean;
  retry?: () => Operation | Promise<Operation>;
  // coalescing
  lastSentAt: number;
  timer?: ReturnType<typeof setTimeout>;
  dirty: boolean;
  expiry?: ReturnType<typeof setTimeout>;
}

/**
 * The daemon jobs a person asked for or would wait for: a full reindex and a full file index. The
 * rest (one task, doc or file re-indexed, Qdrant and knowledge reconciles) is queued by every edit,
 * dozens at a time during a batch, so it is shown only when it failed.
 */
const VISIBLE_JOB_KINDS = new Set(["reindex-search", "index-all-files"]);

export class OperationRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly dismissals: DismissStore;
  private seq = 0;
  private counter = 0;
  private clients = 0;
  private jobSource: JobOperationSource | undefined;
  private stopWatch: (() => void) | undefined;
  private unsubJobs: (() => void) | undefined;
  private closed = false;
  private readonly now: () => number;
  private readonly minInterval: number;
  private readonly doneExpiry: number;
  private readonly failedCap: number;
  private readonly failedMaxAge: number;

  constructor(private readonly deps: RegistryDeps) {
    this.now = deps.now ?? Date.now;
    this.minInterval = deps.minIntervalMs ?? OPERATION_EVENT_MIN_INTERVAL_MS;
    this.doneExpiry = deps.doneExpiryMs ?? OPERATION_DONE_EXPIRY_MS;
    this.failedCap = deps.failedCap ?? OPERATION_FAILED_CAP;
    this.failedMaxAge = deps.failedMaxAgeMs ?? OPERATION_FAILED_MAX_AGE_MS;
    this.dismissals = deps.dismissals ?? memoryDismissals();
  }

  // ---- web operations -------------------------------------------------------------------------

  start(spec: StartSpec): OperationHandle {
    const t = this.now();
    const id = `op_${t.toString(36)}_${(++this.counter).toString(36)}`;
    const op: Operation = {
      id,
      source: "web",
      kind: spec.kind,
      title: spec.title,
      project: spec.project ?? null,
      projectRoot: spec.projectRoot ?? null,
      state: spec.state ?? "running",
      progress: spec.progress ?? null,
      cancellable: spec.cancellable ?? false,
      retryable: false,
      error: null,
      message: spec.message ?? null,
      startedAt: t,
      updatedAt: t,
      finishedAt: null,
    };
    const e: Entry = {
      op,
      web: true,
      cancelRequested: false,
      ...(spec.retry && { retry: spec.retry }),
      lastSentAt: t,
      dirty: false,
    };
    this.entries.set(id, e);
    this.send("operation:started", e);
    return {
      id,
      progress: (done, total) => this.setProgress(e, done, total),
      get cancelRequested() {
        return e.cancelRequested;
      },
      setCancellable: (v) => {
        if (isTerminalState(e.op.state) || e.op.cancellable === v) return;
        e.op.cancellable = v && !e.cancelRequested;
        this.stateChanged(e);
      },
      finish: (m) => this.terminal(e, "done", null, m ?? null),
      fail: (error, m) => this.terminal(e, "failed", error, m ?? null),
      cancelled: (m) => this.terminal(e, "cancelled", null, m ?? null),
    };
  }

  private setProgress(e: Entry, done: number, total: number): void {
    if (isTerminalState(e.op.state)) return;
    const p = e.op.progress;
    if (p && p.done === done && p.total === total) return;
    e.op.progress = { done, total };
    e.op.updatedAt = this.now();
    this.scheduleUpdate(e);
  }

  private terminal(e: Entry, state: OperationState, error: string | null, message: string | null) {
    if (isTerminalState(e.op.state)) return;
    const t = this.now();
    e.op.state = state;
    e.op.error = error;
    if (message !== null) e.op.message = message;
    e.op.cancellable = false;
    e.op.retryable = state !== "done" && e.retry !== undefined;
    e.op.updatedAt = t;
    e.op.finishedAt = t;
    this.clearTimer(e);
    this.send("operation:finished", e);
    if (state === "failed") this.capFailed();
    else this.armExpiry(e);
  }

  // ---- requests from the routes ---------------------------------------------------------------

  /**
   * Loads the daemon job source if this process has not yet. A snapshot or a dismiss does not
   * depend on an open event stream: the queues can be read at any time.
   */
  async load(): Promise<void> {
    if (this.jobSource || this.closed || !this.deps.jobs) return;
    try {
      this.jobSource = await this.deps.jobs();
    } catch {
      // no job source: only web operations
    }
  }

  snapshot(): OperationSnapshot {
    this.refreshJobs();
    this.dropStaleJobs();
    return {
      seq: this.seq,
      operations: [...this.entries.values()].map((e) => ({ ...e.op })),
      currentProjectRoot: this.deps.currentProjectRoot?.() ?? null,
    };
  }

  get(id: string): Operation | undefined {
    const e = this.entries.get(id);
    return e ? { ...e.op } : undefined;
  }

  /** Idempotent. `conflict` when it is not cancellable and not terminal. */
  async cancel(
    id: string,
  ): Promise<{ status: "ok" | "unknown" | "conflict"; operation?: Operation; error?: string }> {
    const e = this.entries.get(id);
    if (!e) return { status: "unknown" };
    if (isTerminalState(e.op.state) || e.op.state === "cancelling") {
      return { status: "ok", operation: { ...e.op } };
    }
    if (!e.op.cancellable) {
      return {
        status: "conflict",
        operation: { ...e.op },
        error: "this operation cannot be cancelled safely",
      };
    }
    if (!e.web) {
      const src = this.jobSource ?? (await this.deps.jobs?.());
      const [, jobId] = splitJobId(id);
      const result =
        src && e.op.projectRoot ? await src.cancelJobOperation(e.op.projectRoot, jobId) : "gone";
      if (result === "gone") {
        this.remove(id);
        return { status: "ok", operation: { ...e.op, state: "cancelled", cancellable: false } };
      }
      if (result === "not_cancellable") {
        e.op.cancellable = false;
        this.stateChanged(e);
        return {
          status: "conflict",
          operation: { ...e.op },
          error: "this job cannot be cancelled safely",
        };
      }
      e.op.state = "cancelling";
      e.op.cancellable = false;
      e.op.updatedAt = this.now();
      this.stateChanged(e);
      return { status: "ok", operation: { ...e.op } };
    }
    e.cancelRequested = true;
    e.op.state = "cancelling";
    e.op.cancellable = false;
    e.op.updatedAt = this.now();
    this.stateChanged(e);
    return { status: "ok", operation: { ...e.op } };
  }

  async retry(
    id: string,
  ): Promise<{ status: "ok" | "unknown" | "conflict"; operation?: Operation; error?: string }> {
    const e = this.entries.get(id);
    if (!e) return { status: "unknown" };
    if (!e.op.retryable) return { status: "conflict", error: "this operation cannot be retried" };
    if (!e.web) {
      const src = this.jobSource ?? (await this.deps.jobs?.());
      const [, jobId] = splitJobId(id);
      const ok =
        src && e.op.projectRoot ? await src.retryJobOperation(e.op.projectRoot, jobId) : false;
      if (!ok) return { status: "conflict", error: "the job could not be retried" };
      // The source may already have reported the job as queued again (same id): then that is the
      // live operation. Otherwise the failed entry goes and the re-queued job is picked up.
      const cur = this.entries.get(id);
      if (cur && isTerminalState(cur.op.state)) {
        this.remove(id);
        this.refreshJobs();
      }
      const again = this.entries.get(id);
      return { status: "ok", operation: { ...(again?.op ?? e.op) } };
    }
    const fresh = await e.retry?.();
    this.remove(id);
    return fresh
      ? { status: "ok", operation: fresh }
      : { status: "conflict", error: "retry failed" };
  }

  /**
   * Removes a finished row. A daemon job is remembered as dismissed (it survives a restart of this
   * server and of the runtime). One this registry has no entry for (no event stream was open when
   * it was listed) is checked against the job source: an unfinished job conflicts, any other job id
   * is dismissed, so the call is idempotent.
   */
  dismiss(id: string): { status: "ok" | "unknown" | "conflict" } {
    const e = this.entries.get(id);
    if (!e) {
      if (!id.startsWith("job:")) return { status: "unknown" };
      const live = this.listJobs().find((o) => o.id === id);
      if (live && !isTerminalState(live.state)) return { status: "conflict" };
      this.dismissals.add([id]);
      return { status: "ok" };
    }
    if (!isTerminalState(e.op.state)) return { status: "conflict" };
    if (!e.web) this.dismissals.add([id]);
    this.remove(id);
    return { status: "ok" };
  }

  /**
   * Dismisses every finished row (done, failed, cancelled), of one project when `projectRoot` is
   * given. Returns the ids removed.
   */
  dismissFinished(projectRoot?: string | null): string[] {
    this.refreshJobs();
    const ids = [...this.entries.values()]
      .filter((e) => isTerminalState(e.op.state))
      .filter((e) => !projectRoot || e.web || e.op.projectRoot === projectRoot)
      .map((e) => e.op.id);
    this.dismissals.add(ids.filter((id) => !this.entries.get(id)?.web));
    for (const id of ids) this.remove(id);
    return ids;
  }

  private listJobs(): Operation[] {
    try {
      return this.jobSource?.listJobOperations() ?? [];
    } catch {
      return [];
    }
  }

  private tooOld(op: Operation): boolean {
    return (
      op.source === "daemon" &&
      op.state === "failed" &&
      op.finishedAt !== null &&
      this.now() - op.finishedAt > this.failedMaxAge
    );
  }

  /** A failed daemon row that aged past the window while this server ran leaves the list. */
  private dropStaleJobs(): void {
    for (const [id, e] of this.entries) if (!e.web && this.tooOld(e.op)) this.remove(id);
  }

  // ---- SSE clients and the daemon job source ---------------------------------------------------

  /** Called with the number of open event streams. The job source is read only while one is open. */
  clientsChanged(n: number): void {
    const was = this.clients;
    this.clients = n;
    if (n > 0 && was === 0) void this.attachJobs();
    else if (n === 0 && was > 0) this.detachJobs();
  }

  private async attachJobs(): Promise<void> {
    if (this.closed || this.unsubJobs || !this.deps.jobs) return;
    let src: JobOperationSource | undefined;
    try {
      src = await this.deps.jobs();
    } catch {
      return;
    }
    if (!src || this.closed || this.clients === 0 || this.unsubJobs) return;
    this.jobSource = src;
    this.unsubJobs = src.onJobOperation((op) => this.mergeJob(op));
    // The first observation is the source's baseline: take it before the snapshot, so a change
    // between the two is reported rather than lost.
    src.observeJobs?.();
    this.stopWatch = this.deps.watchJobs?.(() => this.jobSource?.observeJobs?.());
    this.refreshJobs();
  }

  private detachJobs(): void {
    this.stopWatch?.();
    this.stopWatch = undefined;
    this.unsubJobs?.();
    this.unsubJobs = undefined;
  }

  /** Merges the job source's current list: new jobs, and ones that vanished from the queue. */
  private refreshJobs(): void {
    const src = this.jobSource;
    if (!src) return;
    let list: Operation[];
    try {
      list = src.listJobOperations();
    } catch {
      return;
    }
    const seen = new Set<string>();
    for (const op of list) {
      seen.add(op.id);
      this.mergeJob(op);
    }
    for (const [id, e] of this.entries) {
      if (!e.web && !seen.has(id) && !isTerminalState(e.op.state) && e.op.state !== "cancelling") {
        this.remove(id);
      }
    }
  }

  private mergeJob(op: Operation): void {
    if (this.closed || this.dismissals.has(op.id) || this.tooOld(op)) return;
    // Housekeeping jobs are shown only when they failed (see VISIBLE_JOB_KINDS).
    if (!VISIBLE_JOB_KINDS.has(op.kind) && op.state !== "failed") return;
    const cur = this.entries.get(op.id);
    if (!cur) {
      const e: Entry = {
        op: { ...op },
        web: false,
        cancelRequested: false,
        lastSentAt: this.now(),
        dirty: false,
      };
      this.entries.set(op.id, e);
      if (isTerminalState(op.state)) {
        this.send("operation:finished", e);
        if (op.state === "failed") this.capFailed();
        else this.armExpiry(e);
      } else this.send("operation:started", e);
      return;
    }
    const was = cur.op.state;
    // A cancel in flight stays cancelling until the job source reports the end.
    const keepCancelling = was === "cancelling" && !isTerminalState(op.state);
    const next: Operation = {
      ...op,
      ...(keepCancelling && { state: "cancelling" as const, cancellable: false }),
    };
    const progressOnly =
      next.state === was &&
      next.cancellable === cur.op.cancellable &&
      next.error === cur.op.error &&
      next.title === cur.op.title;
    cur.op = next;
    if (isTerminalState(next.state)) {
      if (isTerminalState(was)) return;
      this.clearTimer(cur);
      this.send("operation:finished", cur);
      if (next.state === "failed") this.capFailed();
      else this.armExpiry(cur);
    } else if (progressOnly) this.scheduleUpdate(cur);
    else this.stateChanged(cur);
  }

  // ---- events ---------------------------------------------------------------------------------

  private stateChanged(e: Entry): void {
    this.clearTimer(e);
    this.send("operation:updated", e);
  }

  /** Leading edge at once, then the latest value after the window. */
  private scheduleUpdate(e: Entry): void {
    const since = this.now() - e.lastSentAt;
    if (since >= this.minInterval && !e.timer) {
      this.send("operation:updated", e);
      return;
    }
    e.dirty = true;
    if (e.timer) return;
    e.timer = setTimeout(
      () => {
        e.timer = undefined;
        if (e.dirty && !isTerminalState(e.op.state)) this.send("operation:updated", e);
      },
      Math.max(1, this.minInterval - since),
    );
    e.timer.unref?.();
  }

  private clearTimer(e: Entry): void {
    if (e.timer) clearTimeout(e.timer);
    e.timer = undefined;
    e.dirty = false;
  }

  private send(name: OperationEventName, e: Entry): void {
    e.lastSentAt = this.now();
    e.dirty = false;
    if (this.clients === 0) {
      this.seq++; // the counter still grows, so a snapshot after the gap is newer than any event it missed
      return;
    }
    this.deps.emit(name, { seq: ++this.seq, operation: { ...e.op } });
  }

  private remove(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    this.clearTimer(e);
    if (e.expiry) clearTimeout(e.expiry);
    this.entries.delete(id);
    this.seq++;
    if (this.clients > 0) this.deps.emit("operation:removed", { seq: this.seq, id });
  }

  private armExpiry(e: Entry): void {
    e.expiry = setTimeout(() => this.remove(e.op.id), this.doneExpiry);
    e.expiry.unref?.();
  }

  private capFailed(): void {
    const failed = [...this.entries.values()]
      .filter((x) => x.op.state === "failed")
      .sort((a, b) => (a.op.finishedAt ?? 0) - (b.op.finishedAt ?? 0));
    while (failed.length > this.failedCap) this.remove((failed.shift() as Entry).op.id);
  }

  close(): void {
    this.closed = true;
    this.detachJobs();
    for (const e of this.entries.values()) {
      this.clearTimer(e);
      if (e.expiry) clearTimeout(e.expiry);
    }
    this.entries.clear();
  }
}

function splitJobId(id: string): [string, string] {
  const i = id.indexOf(":");
  return i < 0 ? ["", id] : [id.slice(0, i), id.slice(i + 1)];
}
