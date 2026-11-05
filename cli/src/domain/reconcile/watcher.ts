// Port of ReconcileScheduler (internal/storage/reconciler.go) and the knowledge watcher
// (internal/cli/watch.go, startRuntimeWatcher in runtime.go). The runtime daemon (TSR-2MPMDK)
// calls startRuntimeWatcher; nothing here appends history from a watch callback: events are
// content-free hints handed to the serialized reconciler.
import {
  type Dirent,
  existsSync,
  type FSWatcher,
  lstatSync,
  readdirSync,
  statSync,
  watch,
} from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { toSlash, under } from "./fs-util.ts";
import { FilesystemReconciler } from "./reconciler.ts";
import {
  type IndexIntent,
  RECONCILE_FLUSH_CEILING_MS,
  RECONCILE_QUIET_WINDOW_MS,
  type ReconcileHint,
} from "./types.ts";

interface Scheduled {
  hint: ReconcileHint;
  first: number;
  last: number;
}

/** A deterministic debounce scheduler: call `tick` from a timer or with an injected clock. */
export class ReconcileScheduler {
  private readonly pending = new Map<string, Scheduled>();
  constructor(
    private readonly emit: (hints: ReconcileHint[]) => void,
    private readonly now: () => number = Date.now,
    private readonly quiet = RECONCILE_QUIET_WINDOW_MS,
    private readonly ceiling = RECONCILE_FLUSH_CEILING_MS,
  ) {}

  /** Identity is the serialization key; the latest path wins, so an A/B/A edit never flushes B. */
  offer(identity: string, _hash: string, path: string): void {
    const now = this.now();
    const old = this.pending.get(identity);
    if (!old) {
      this.pending.set(identity, { hint: { path, at: new Date(now) }, first: now, last: now });
      return;
    }
    old.last = now;
    old.hint.path = path;
  }

  tick(): void {
    const now = this.now();
    const out: ReconcileHint[] = [];
    for (const [key, p] of this.pending) {
      if (now - p.last >= this.quiet || now - p.first >= this.ceiling) {
        out.push(p.hint);
        this.pending.delete(key);
      }
    }
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (out.length > 0) this.emit(out);
  }

  get size(): number {
    return this.pending.size;
  }
}

function underRoot(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return (
    rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("/") && !/^[A-Za-z]:/.test(rel)
  );
}

/** knowledgeDirectoryAllowed: a real (non-symlink) directory inside tasks/ or docs/. */
export function knowledgeDirectoryAllowed(storeRoot: string, candidate: string): boolean {
  const root = resolve(storeRoot);
  const path = resolve(candidate);
  const canonicalRoot = ["tasks", "docs"].map((n) => join(root, n)).find((r) => underRoot(r, path));
  if (!canonicalRoot) return false;
  for (let current = path; ; current = resolve(current, "..")) {
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(current);
    } catch {
      return false;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) return false;
    if (resolve(current) === resolve(canonicalRoot)) return true;
    const parent = resolve(current, "..");
    if (parent === current || !underRoot(canonicalRoot, parent)) return false;
  }
}

/** isKnowledgeEvent: a visible, non-temporary Markdown file under tasks/ or docs/. */
export function isKnowledgeEvent(path: string, storeRoot: string): boolean {
  const abs = resolve(path);
  if (!underRoot(join(storeRoot, "tasks"), abs) && !underRoot(join(storeRoot, "docs"), abs))
    return false;
  const base = basename(abs);
  return !(
    base.startsWith(".") ||
    base.endsWith(".tmp") ||
    base.endsWith("~") ||
    extname(base).toLowerCase() !== ".md"
  );
}

export interface KnowledgeWatcherOptions {
  signal: AbortSignal;
  /** Receives coalesced hints; throwing stops the watcher with that error. */
  enqueue: (hints: ReconcileHint[]) => void;
  tickMs?: number;
  /** How often recreated (polled) directories are rescanned. */
  pollMs?: number;
  onError?: (err: unknown) => void;
}

/**
 * StartKnowledgeWatcher observes only canonical Task/Doc Markdown roots (never the source tree: a
 * descriptor per watched file exhausted macOS kqueue limits). Resolves when the signal aborts.
 */
export function startKnowledgeWatcher(
  storeRootIn: string,
  opts: KnowledgeWatcherOptions,
): Promise<void> {
  const storeRoot = resolve(storeRootIn);
  return new Promise<void>((done, fail) => {
    const watchers = new Map<string, FSWatcher>();
    // Directories whose watch was dropped because they disappeared. Bun on Linux never delivers
    // events to a new watch on a path it watched before (even after close, even recursive), so a
    // recreated directory is polled instead: name -> "mtime:size" of its entries.
    const dropped = new Set<string>();
    const polled = new Map<string, Map<string, string>>();
    let timer: ReturnType<typeof setInterval> | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let enqueueErr: unknown;
    const scheduler = new ReconcileScheduler((batch) => {
      try {
        opts.enqueue(batch);
      } catch (e) {
        enqueueErr = e;
      }
    });
    const finish = (err?: unknown) => {
      if (timer) clearInterval(timer);
      if (pollTimer) clearInterval(pollTimer);
      for (const w of watchers.values()) w.close();
      watchers.clear();
      polled.clear();
      if (err) fail(err);
      else done();
    };
    // fsnotify drops a watch when its directory goes away and re-adds it on Create. Node keeps a
    // dead handle in the map instead (inotify watches die with the inode; Windows raises EPERM),
    // so a removed directory and everything under it are forgotten here, and a recreated one is
    // picked up again (polled, see `dropped`) when its parent reports it.
    const dropDirs = (dir: string): void => {
      const prefix = dir + sep;
      for (const [d, w] of watchers) {
        if (d === dir || d.startsWith(prefix)) {
          w.close();
          watchers.delete(d);
          dropped.add(d);
        }
      }
      for (const d of [...polled.keys()]) {
        if (d === dir || d.startsWith(prefix)) polled.delete(d);
      }
    };
    const offer = (full: string): void => {
      if (!isKnowledgeEvent(full, storeRoot)) return;
      const rel = relative(storeRoot, full);
      if (rel === "" || rel.startsWith("..")) return;
      scheduler.offer(full, "", full);
    };
    const signatures = (dir: string, entries: Dirent[]): Map<string, string> => {
      const out = new Map<string, string>();
      for (const e of entries) {
        if (!e.isFile()) continue;
        try {
          const st = statSync(join(dir, e.name));
          out.set(e.name, `${st.mtimeMs}:${st.size}`);
        } catch {
          // vanished between readdir and stat: the next poll reports it
        }
      }
      return out;
    };
    const pollOnce = (): void => {
      for (const [dir, prev] of [...polled]) {
        let entries: Dirent[];
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          for (const name of prev.keys()) offer(join(dir, name));
          dropDirs(dir);
          continue;
        }
        const next = signatures(dir, entries);
        for (const [name, sig] of next) if (prev.get(name) !== sig) offer(join(dir, name));
        for (const name of prev.keys()) if (!next.has(name)) offer(join(dir, name));
        polled.set(dir, next);
        for (const e of entries) {
          if (e.isDirectory() && !e.isSymbolicLink()) addDirs(join(dir, e.name));
        }
      }
    };
    const addDirs = (dir: string): void => {
      if (!knowledgeDirectoryAllowed(storeRoot, dir)) return;
      if (polled.has(dir)) return;
      if (!watchers.has(dir) && dropped.has(dir)) {
        // Recreated: whatever it already holds is new (git stash pop writes files at once).
        let entries: Dirent[];
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        const sigs = signatures(dir, entries);
        for (const name of sigs.keys()) offer(join(dir, name));
        polled.set(dir, sigs);
        for (const e of entries) {
          if (e.isDirectory() && !e.isSymbolicLink()) addDirs(join(dir, e.name));
        }
        return;
      }
      if (!watchers.has(dir)) {
        const w = watch(dir, (_event, filename) => {
          if (!filename) return;
          const full = join(dir, filename.toString());
          // A created directory needs its own watch; prove a real in-root directory first.
          try {
            if (statSync(full).isDirectory() && knowledgeDirectoryAllowed(storeRoot, full)) {
              addDirs(full);
              return;
            }
          } catch {
            // removed or renamed away: still a hint for the manifest-owned path
            dropDirs(full);
          }
          offer(full);
        });
        w.on("error", (e) => {
          dropDirs(dir);
          opts.onError?.(e);
        });
        watchers.set(dir, w);
      }
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        // Gone between the event and the walk: forget it; the parent reports a recreation.
        if (watchers.has(dir) && !existsSync(dir)) {
          dropDirs(dir);
          return;
        }
        throw e;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) addDirs(join(dir, entry.name));
      }
    };
    try {
      for (const root of ["tasks", "docs"]) addDirs(join(storeRoot, root));
    } catch (e) {
      finish(e);
      return;
    }
    timer = setInterval(() => {
      scheduler.tick();
      if (enqueueErr) finish(enqueueErr);
    }, opts.tickMs ?? 100);
    pollTimer = setInterval(() => {
      if (polled.size === 0) return;
      try {
        pollOnce();
      } catch (e) {
        opts.onError?.(e);
      }
    }, opts.pollMs ?? 1000);
    if (opts.signal.aborted) finish();
    else opts.signal.addEventListener("abort", () => finish(), { once: true });
  });
}

export interface RuntimeWatcherOptions {
  signal: AbortSignal;
  /** The runtime's indexing handoff (runtimeIndexEnqueuer). */
  index?: IndexIntent;
  onError?: (err: unknown) => void;
}

/**
 * startRuntimeWatcher: reconcile offline edits first (durable startup boundary), then reconcile
 * watcher batches through one serialized worker. Mirrors internal/cli/runtime.go.
 */
export async function startRuntimeWatcher(
  storeRoot: string,
  opts: RuntimeWatcherOptions,
): Promise<void> {
  const reconciler = new FilesystemReconciler(storeRoot, {
    signal: opts.signal,
    ...(opts.index && { index: opts.index }),
  });
  await reconciler.reconcileLifecycleWithOptions(true, { source: "watcher-startup", wait: true });
  const pending = new Map<string, ReconcileHint>();
  let running = false;
  const drain = async () => {
    if (running) return;
    running = true;
    try {
      while (pending.size > 0 && !opts.signal.aborted) {
        const batch = [...pending.values()];
        pending.clear();
        try {
          await reconciler.reconcileLifecycleBatchWithOptions(
            { source: "watcher", hints: batch, limit: 512 },
            true,
            true,
          );
        } catch (e) {
          if (opts.onError) opts.onError(e);
          else process.stderr.write(`knowledge reconciliation error: ${(e as Error).message}\n`);
        }
      }
    } finally {
      running = false;
    }
  };
  await startKnowledgeWatcher(storeRoot, {
    signal: opts.signal,
    ...(opts.onError && { onError: opts.onError }),
    enqueue(batch) {
      for (const hint of batch) {
        if (pending.size >= 4096 && !pending.has(hint.path)) {
          throw new Error("knowledge hint queue capacity exceeded (4096); retry reconciliation");
        }
        pending.set(hint.path, hint);
      }
      void drain();
    },
  });
}

export { toSlash, under };
